import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ApprovalActor,
  ApprovalRecord,
  CreateTaskInput,
  MergeInput,
  MergeResult,
  TaskRecord,
  TaskStatus,
} from '@aggregator/shared';
import { newId, TERMINAL_STATUSES } from '@aggregator/shared';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { SpawnContext } from '../adapters/types.js';
import type { ApprovalService } from '../approvals.js';
import type { DaemonConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Bus } from '../events.js';
import { RepoPathError, type WorktreeManager } from '../git/WorktreeManager.js';
import { classifyTool } from '../policy.js';
import type { TaskRunner } from './TaskRunner.js';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TaskStatusSummary {
  task_id: string;
  agent: string;
  title: string;
  status: TaskStatus;
  exit_code: number | null;
  verify_output_tail: string | null;
  error_message: string | null;
  changed_files_count: number | null;
  pending_approval_ids: string[];
}

export type MergeOutcome = MergeResult | { status: 'pending_approval'; approvalId: string };

interface Job {
  taskId: string;
  prompt: string;
  resumeSessionId?: string;
}

const MERGE_TOOL = 'merge_worktree';
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TAIL = 20_000;

export interface TaskServiceDeps {
  repo: Repo;
  wm: WorktreeManager;
  registry: AdapterRegistry;
  runner: TaskRunner;
  approvals: ApprovalService;
  bus: Bus;
  config: Pick<DaemonConfig, 'maxConcurrent' | 'requireHumanMerge' | 'approvalTimeoutMs'>;
  /** Base URL workers use to reach the daemon (hook script). */
  daemonUrl: () => string;
}

export class TaskService {
  private readonly queue: Job[] = [];
  private readonly active = new Set<string>(); // starting, running or verifying
  private readonly hookTokens = new Map<string, string>();
  private readonly killReason = new Map<string, 'cancel' | 'shutdown'>();
  private readonly verifiers = new Map<string, ChildProcess>();
  private readonly d: TaskServiceDeps;

  constructor(deps: TaskServiceDeps) {
    this.d = deps;
    // Keep task status honest while approvals are pending, and run human-approved merges.
    deps.bus.on('approval.requested', (a) => this.onApprovalChange(a));
    deps.bus.on('approval.resolved', (a) => {
      this.onApprovalChange(a);
      if (a.toolName === MERGE_TOOL && a.status === 'approved') void this.executeApprovedMerge(a);
    });
  }

  // ---------------------------------------------------------------- creation / control

  async createTask(input: CreateTaskInput): Promise<{ task: TaskRecord; warnings: string[] }> {
    const { repo, wm, registry } = this.d;
    const adapter = registry.get(input.agent);
    if (!adapter) throw new ServiceError(400, `unknown agent "${input.agent}"`);

    let root: string;
    try {
      root = await wm.resolveRepoRoot(input.repoPath);
    } catch (err) {
      throw new ServiceError(400, err instanceof RepoPathError ? err.message : `repo_path is not a git repository: ${input.repoPath}`);
    }
    if (!(await wm.branchExists(root, input.baseBranch))) {
      throw new ServiceError(400, `base branch "${input.baseBranch}" does not exist in ${root}`);
    }
    if (input.parentTaskId && !repo.getTask(input.parentTaskId)) throw new ServiceError(400, 'parent task not found');

    const id = newId('tsk');
    const { worktreePath, branch } = await wm.createWorktree(root, input.baseBranch, input.agent, id);
    const { id: repoId } = repo.upsertRepository(root, input.baseBranch);
    const task = repo.insertTask({
      id,
      repoId,
      parentTaskId: input.parentTaskId ?? null,
      agentId: input.agent,
      title: input.title,
      prompt: input.prompt,
      baseBranch: input.baseBranch,
      branchName: branch,
      worktreePath,
      approvalPolicy: input.approvalPolicy,
      verifyCommand: input.verifyCommand ?? null,
    });

    const warnings: string[] = [];
    if (!adapter.supportsApprovalGating && input.approvalPolicy !== 'auto_edit') {
      warnings.push(
        `${adapter.displayName} cannot gate approvals in this configuration; approval_policy "${input.approvalPolicy}" is not enforced ` +
          `(the agent runs inside its own sandbox). Configure a PTY command with approvalRegex in agents.json to enable gating.`,
      );
      repo.appendLog(id, 'system', warnings[0]!);
    }

    this.enqueue({ taskId: id, prompt: input.prompt });
    this.d.bus.emit('task.created', repo.getTask(id)!);
    return { task: repo.getTask(id)!, warnings };
  }

  getTask(id: string): TaskRecord {
    const task = this.d.repo.getTask(id);
    if (!task) throw new ServiceError(404, `task not found: ${id}`);
    return task;
  }

  listTasks(filter?: { status?: TaskStatus[]; repoId?: string }): TaskRecord[] {
    return this.d.repo.listTasks(filter);
  }

  cancel(id: string): TaskRecord {
    const task = this.getTask(id);
    if (TERMINAL_STATUSES.includes(task.status)) return task;
    const queued = this.queue.findIndex((j) => j.taskId === id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.setStatus(id, 'cancelled', { completedAt: Date.now() });
    } else if (this.verifiers.has(id)) {
      this.killReason.set(id, 'cancel');
      this.verifiers.get(id)!.kill('SIGTERM');
    } else if (this.d.runner.isActive(id)) {
      this.killReason.set(id, 'cancel');
      this.d.runner.kill(id);
    } else {
      this.setStatus(id, 'cancelled', { completedAt: Date.now() });
    }
    return this.getTask(id);
  }

  retry(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!['failed', 'cancelled', 'rate_limited'].includes(task.status)) {
      throw new ServiceError(409, `task is ${task.status}; only failed, cancelled or rate_limited tasks can be retried`);
    }
    this.enqueue({ taskId: id, prompt: task.prompt });
    return this.getTask(id);
  }

  sendInput(id: string, data: string): void {
    this.getTask(id);
    if (!this.d.runner.write(id, data)) throw new ServiceError(409, 'task has no running process to receive input');
  }

  /**
   * Follow-up for the worker. A live PTY session gets the text typed in; a finished worker is restarted in the
   * same worktree, either through the agent's native session resume or by replaying the original task.
   */
  sendFeedback(id: string, message: string): TaskRecord {
    const task = this.getTask(id);
    if (this.d.runner.isActive(id)) {
      if (!this.d.runner.usesPty(id)) {
        throw new ServiceError(409, 'worker is running headless; send feedback after it finishes, or cancel it first');
      }
      this.d.runner.write(id, message + '\r');
      return task;
    }
    if (['merged', 'queued', 'verifying'].includes(task.status) || this.active.has(id)) {
      throw new ServiceError(409, `task is ${task.status}; feedback can be sent while it is running or after it finished`);
    }
    const adapter = this.d.registry.get(task.agentId);
    if (adapter?.supportsNativeResume && task.sessionId) {
      this.enqueue({ taskId: id, prompt: message, resumeSessionId: task.sessionId });
    } else {
      const prompt =
        `You are continuing earlier work in this same worktree; your previous changes are already present.\n\n` +
        `Original task:\n${task.prompt}\n\nFollow-up from the reviewer:\n${message}`;
      this.enqueue({ taskId: id, prompt });
    }
    return this.getTask(id);
  }

  // ---------------------------------------------------------------- status / diff

  /** Returns right away if any task is already settled or needs attention; otherwise waits for a state change. */
  async getStatuses(ids: string[], waitSeconds = 0): Promise<TaskStatusSummary[]> {
    const initial = ids.map((id) => this.getTask(id));
    const attention = (t: TaskRecord) => TERMINAL_STATUSES.includes(t.status) || t.status === 'waiting_approval';
    if (waitSeconds > 0 && !initial.some(attention)) {
      const before = new Map(initial.map((t) => [t.id, t.status]));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(waitSeconds, 60) * 1000);
        const listener = (e: { taskId: string; status: string }) => {
          if (before.has(e.taskId) && before.get(e.taskId) !== e.status) done();
        };
        function done() {
          clearTimeout(timer);
          off();
          resolve();
        }
        const off = () => this.d.bus.off('task.updated', listener);
        this.d.bus.on('task.updated', listener);
      });
    }
    return Promise.all(ids.map((id) => this.summarize(this.getTask(id))));
  }

  private async summarize(t: TaskRecord): Promise<TaskStatusSummary> {
    let changed: number | null = null;
    if (t.status !== 'merged' && t.status !== 'queued') {
      try {
        changed = (await this.d.wm.getDiff(t.worktreePath, t.baseBranch)).files.length;
      } catch {
        changed = null;
      }
    }
    return {
      task_id: t.id,
      agent: t.agentId,
      title: t.title,
      status: t.status,
      exit_code: t.exitCode,
      verify_output_tail: t.verifyOutput ? t.verifyOutput.slice(-2000) : null,
      error_message: t.errorMessage,
      changed_files_count: changed,
      pending_approval_ids: this.d.repo.listApprovals('pending').filter((a) => a.taskId === t.id).map((a) => a.id),
    };
  }

  async getDiff(id: string, fileFilter?: string, maxLines = 500) {
    const task = this.getTask(id);
    if (task.status === 'merged') throw new ServiceError(409, 'task is already merged; its worktree no longer exists');
    const { diff, files, mergeBase } = await this.d.wm.getDiff(task.worktreePath, task.baseBranch, fileFilter);
    const lines = diff.split('\n');
    const truncated = lines.length > maxLines;
    return {
      task_id: id,
      branch: task.branchName,
      base_branch: task.baseBranch,
      merge_base: mergeBase,
      files,
      truncated,
      total_lines: lines.length,
      diff: truncated ? lines.slice(0, maxLines).join('\n') : diff,
    };
  }

  getLogs(id: string, afterId = 0, limit = 1000) {
    this.getTask(id);
    return this.d.repo.getLogs(id, afterId, limit);
  }

  getTerminalBuffer(id: string): string {
    return this.d.runner.getBuffer(id);
  }

  getTerminalSeq(id: string): number {
    return this.d.runner.getSeq(id);
  }

  // ---------------------------------------------------------------- merge

  async merge(id: string, input: MergeInput, actor: ApprovalActor): Promise<MergeOutcome> {
    const task = this.getTask(id);
    if (task.status !== 'completed') {
      throw new ServiceError(409, `task is ${task.status}; only completed tasks can be merged`);
    }
    const request = { targetBranch: input.targetBranch ?? task.baseBranch, squash: input.squash, commitMessage: input.commitMessage };

    if (actor === 'manager_agent' && this.d.config.requireHumanMerge) {
      const approval = this.d.approvals.create({
        task,
        toolName: MERGE_TOOL,
        summary: `Merge ${task.branchName} into ${request.targetBranch}${request.squash ? ' (squash)' : ''}`,
        rawPayload: request,
        forceAsk: true,
      });
      return { status: 'pending_approval', approvalId: approval.id };
    }
    return this.doMerge(task, request);
  }

  private async doMerge(
    task: TaskRecord,
    req: { targetBranch: string; squash: boolean; commitMessage?: string },
  ): Promise<MergeResult> {
    const repoRow = this.d.repo.getRepository(task.repoId);
    if (!repoRow) throw new ServiceError(500, 'repository record missing');
    const result = await this.d.wm.mergeWorktree(
      repoRow.rootPath,
      task.worktreePath,
      task.branchName,
      req.targetBranch,
      req.squash,
      req.commitMessage ?? `${task.title} (${task.id})`,
    );
    if (result.status === 'merged') {
      this.d.runner.dropBuffer(task.id);
      this.setStatus(task.id, 'merged', { errorMessage: null });
    } else {
      const note =
        result.status === 'conflict'
          ? `merge_conflict: ${result.conflictedFiles.join(', ')}`
          : `merge_blocked: ${result.message}`;
      this.d.repo.updateTask(task.id, { errorMessage: note });
      this.d.repo.appendLog(task.id, 'system', note);
      this.d.bus.emit('task.updated', { taskId: task.id, status: task.status, updatedAt: Date.now() });
    }
    return result;
  }

  private async executeApprovedMerge(a: ApprovalRecord): Promise<void> {
    try {
      const task = this.d.repo.getTask(a.taskId);
      if (!task || task.status !== 'completed') return;
      await this.doMerge(task, JSON.parse(a.rawPayload) as { targetBranch: string; squash: boolean; commitMessage?: string });
    } catch (err) {
      this.d.repo.updateTask(a.taskId, { errorMessage: `merge_failed: ${(err as Error).message}` });
    }
  }

  // ---------------------------------------------------------------- hook approvals

  verifyHookToken(taskId: string, token: string): boolean {
    const expected = this.hookTokens.get(taskId);
    if (!expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  createToolApproval(taskId: string, toolName: string, toolInput: Record<string, unknown>): ApprovalRecord {
    const task = this.getTask(taskId);
    const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
    const filePath = [toolInput.file_path, toolInput.notebook_path, toolInput.path].find((v) => typeof v === 'string') as string | undefined;
    const kind = classifyTool(toolName);
    const summary = kind === 'shell' ? (command ?? toolName) : filePath ? `${toolName} ${filePath}` : toolName;
    return this.d.approvals.create({ task, toolName, summary, rawPayload: toolInput, command, filePath });
  }

  // ---------------------------------------------------------------- scheduling

  private enqueue(job: Job): void {
    if (this.active.size >= this.d.config.maxConcurrent) {
      this.queue.push(job);
      this.setStatus(job.taskId, 'queued');
      return;
    }
    this.active.add(job.taskId);
    this.setStatus(job.taskId, 'running');
    void this.startRun(job).catch((err) => this.fail(job.taskId, `failed to start: ${(err as Error).message}`));
  }

  private drain(): void {
    while (this.queue.length && this.active.size < this.d.config.maxConcurrent) {
      const job = this.queue.shift()!;
      this.active.add(job.taskId);
      void this.startRun(job).catch((err) => this.fail(job.taskId, `failed to start: ${(err as Error).message}`));
    }
  }

  private async startRun(job: Job): Promise<void> {
    const { repo, registry, runner, bus } = this.d;
    const task = this.getTask(job.taskId);
    const adapter = registry.get(task.agentId);
    if (!adapter) return this.fail(task.id, `no adapter for agent "${task.agentId}"`);
    const installed = await adapter.detectInstalled();
    if (!installed.installed) return this.fail(task.id, `${adapter.displayName} CLI was not found on PATH`);

    const hookToken = randomBytes(24).toString('hex');
    this.hookTokens.set(task.id, hookToken);
    const ctx: SpawnContext = {
      taskId: task.id,
      worktreePath: task.worktreePath,
      prompt: job.prompt,
      approvalPolicy: task.approvalPolicy,
      resumeSessionId: job.resumeSessionId,
      env: {
        AGGREGATOR_URL: this.d.daemonUrl(),
        AGGREGATOR_TASK_ID: task.id,
        AGGREGATOR_HOOK_TOKEN: hookToken,
      },
    };
    await adapter.prepareWorktree?.(ctx);

    this.setStatus(task.id, 'running', { startedAt: task.startedAt ?? Date.now(), completedAt: null, exitCode: null, errorMessage: null });
    repo.recordUsage(task.agentId, task.id, 'task_started');
    repo.appendLog(task.id, 'system', `started ${adapter.displayName}${job.resumeSessionId ? ` (resuming ${job.resumeSessionId})` : ''}`);

    runner.start(adapter, ctx, {
      onEvent: (ev) => {
        if (ev.type === 'session') repo.updateTask(task.id, { sessionId: ev.sessionId });
      },
      onRateLimit: ({ retryAfterSeconds }) => {
        repo.recordUsage(task.agentId, task.id, 'rate_limited', undefined, retryAfterSeconds);
        void this.suggestFallback(task.agentId).then((fallbackSuggested) =>
          bus.emit('agent.rateLimited', {
            agent: task.agentId,
            resetAt: retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : null,
            fallbackSuggested,
          }),
        );
      },
      onApprovalPrompt: (info, answer) => {
        const approval = this.d.approvals.create({
          task: this.getTask(task.id),
          toolName: 'shell',
          summary: info.actionSummary,
          rawPayload: { command: info.actionSummary },
          command: info.actionSummary,
        });
        void this.d.approvals
          .wait(approval.id, this.d.config.approvalTimeoutMs + 5000)
          .then((final) => answer(final.status === 'approved' ? 'approve' : 'deny'));
      },
      onExit: (info) => void this.finalize(task.id, info),
    });
  }

  private async finalize(id: string, info: { exitCode: number | null; rateLimited: boolean; killed: boolean }): Promise<void> {
    const { repo, wm, approvals } = this.d;
    this.hookTokens.delete(id);
    approvals.expireForTask(id);
    const task = this.getTask(id);
    const durationMs = Date.now() - (task.startedAt ?? Date.now());
    const done = (status: TaskStatus, extra: Parameters<Repo['updateTask']>[1] = {}) => {
      this.active.delete(id);
      this.killReason.delete(id);
      this.setStatus(id, status, { completedAt: Date.now(), exitCode: info.exitCode, ...extra });
      this.drain();
    };

    try {
      if (info.rateLimited) return done('rate_limited', { errorMessage: 'agent hit a rate limit' });
      const reason = this.killReason.get(id);
      if (info.killed || reason) {
        return reason === 'shutdown'
          ? done('failed', { errorMessage: 'daemon shut down while the task was running' })
          : done('cancelled');
      }
      if (info.exitCode !== 0) return done('failed', { errorMessage: `agent exited with code ${info.exitCode}` });

      await wm.commitAll(task.worktreePath, `${task.title} (${task.id})`).catch((err) => {
        repo.appendLog(id, 'system', `auto-commit failed: ${(err as Error).message}`);
      });
      repo.recordUsage(task.agentId, id, 'task_completed', durationMs);

      if (!task.verifyCommand) return done('completed');

      this.setStatus(id, 'verifying');
      const verify = await this.runVerify(id, task);
      repo.updateTask(id, { verifyOutput: verify.output });
      repo.appendLog(id, 'verify', verify.output);
      if (this.killReason.get(id) === 'cancel') return done('cancelled');
      return verify.exitCode === 0
        ? done('completed')
        : done('failed', { errorMessage: `verification failed (exit ${verify.exitCode})` });
    } catch (err) {
      return done('failed', { errorMessage: `finalize error: ${(err as Error).message}` });
    }
  }

  private runVerify(id: string, task: TaskRecord): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', task.verifyCommand!], { cwd: task.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
      this.verifiers.set(id, child);
      let output = '';
      const collect = (d: Buffer) => {
        output = (output + d.toString('utf8')).slice(-VERIFY_TAIL);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        output += '\n[verify timed out]';
        child.kill('SIGKILL');
      }, VERIFY_TIMEOUT_MS);
      const end = (exitCode: number | null) => {
        clearTimeout(timer);
        this.verifiers.delete(id);
        resolve({ exitCode, output });
      };
      child.on('error', (e) => {
        output += `\n${e.message}`;
        end(127);
      });
      child.on('close', (code) => end(code));
    });
  }

  private fail(id: string, message: string): void {
    this.active.delete(id);
    this.hookTokens.delete(id);
    this.d.repo.appendLog(id, 'system', message);
    this.setStatus(id, 'failed', { errorMessage: message, completedAt: Date.now() });
    this.drain();
  }

  private setStatus(id: string, status: TaskStatus, extra: Parameters<Repo['updateTask']>[1] = {}): void {
    this.d.repo.updateTask(id, { status, ...extra });
    this.d.bus.emit('task.updated', { taskId: id, status, updatedAt: Date.now() });
  }

  private onApprovalChange(a: ApprovalRecord): void {
    if (a.toolName === MERGE_TOOL) return;
    const task = this.d.repo.getTask(a.taskId);
    if (!task) return;
    const pending = this.d.repo.pendingApprovalCount(task.id);
    if (pending > 0 && task.status === 'running') this.setStatus(task.id, 'waiting_approval');
    else if (pending === 0 && task.status === 'waiting_approval') this.setStatus(task.id, 'running');
  }

  private async suggestFallback(agentId: string): Promise<string | null> {
    for (const adapter of this.d.registry.list()) {
      if (adapter.id === agentId || this.d.repo.activeRateLimit(adapter.id)) continue;
      if ((await adapter.detectInstalled()).installed) return adapter.id;
    }
    return null;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Startup: nothing survives a daemon restart as a live process, so make persisted state truthful. */
  async recover(): Promise<{ failedTasks: number }> {
    const { repo, wm } = this.d;
    const stale = repo.listTasks({ status: ['queued', 'running', 'waiting_approval', 'verifying'] });
    for (const t of stale) {
      repo.updateTask(t.id, {
        status: 'failed',
        errorMessage: 'daemon restarted while this task was active; retry it to run again in the same worktree',
        completedAt: Date.now(),
      });
    }
    for (const a of repo.listApprovals('pending')) repo.resolveApproval(a.id, 'expired', 'policy');
    const roots = new Set(repo.listTasks().map((t) => repo.getRepository(t.repoId)?.rootPath).filter(Boolean) as string[]);
    for (const root of roots) await wm.prune(root).catch(() => undefined);
    return { failedTasks: stale.length };
  }

  /** Stops all workers and resolves once their exit handlers have persisted final state (or after `graceMs`). */
  async shutdown(graceMs = 8000): Promise<void> {
    for (const id of this.active) this.killReason.set(id, 'shutdown');
    this.queue.length = 0;
    this.d.runner.killAll();
    for (const child of this.verifiers.values()) child.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (this.active.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  }
}
