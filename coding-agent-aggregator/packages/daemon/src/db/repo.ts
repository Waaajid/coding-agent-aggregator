import type { ApprovalActor, ApprovalRecord, ApprovalStatus, TaskRecord, TaskStatus } from '@aggregator/shared';
import { newId } from '@aggregator/shared';
import type { Db } from './index.js';

type Row = Record<string, unknown>;

function toTask(r: Row): TaskRecord {
  return {
    id: r.id as string,
    repoId: r.repo_id as string,
    parentTaskId: (r.parent_task_id as string) ?? null,
    agentId: r.agent_id as TaskRecord['agentId'],
    role: r.role as TaskRecord['role'],
    title: r.title as string,
    prompt: r.prompt as string,
    baseBranch: r.base_branch as string,
    branchName: r.branch_name as string,
    worktreePath: r.worktree_path as string,
    approvalPolicy: r.approval_policy as TaskRecord['approvalPolicy'],
    verifyCommand: (r.verify_command as string) ?? null,
    status: r.status as TaskStatus,
    exitCode: (r.exit_code as number) ?? null,
    verifyOutput: (r.verify_output as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    createdAt: r.created_at as number,
    startedAt: (r.started_at as number) ?? null,
    completedAt: (r.completed_at as number) ?? null,
  };
}

function toApproval(r: Row): ApprovalRecord {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    agentId: r.agent_id as ApprovalRecord['agentId'],
    toolName: r.tool_name as string,
    summary: r.summary as string,
    rawPayload: r.raw_payload as string,
    status: r.status as ApprovalStatus,
    resolvedBy: (r.resolved_by as ApprovalActor) ?? null,
    createdAt: r.created_at as number,
    resolvedAt: (r.resolved_at as number) ?? null,
  };
}

export type NewTask = Omit<
  TaskRecord,
  'status' | 'exitCode' | 'verifyOutput' | 'errorMessage' | 'sessionId' | 'createdAt' | 'startedAt' | 'completedAt' | 'role'
> & { role?: TaskRecord['role'] };

export class Repo {
  constructor(private readonly db: Db) {}

  upsertRepository(rootPath: string, defaultBranch: string): { id: string } {
    const existing = this.db.prepare('SELECT id FROM repositories WHERE root_path = ?').get(rootPath) as Row | undefined;
    if (existing) return { id: existing.id as string };
    const id = newId('repo');
    const name = rootPath.split('/').filter(Boolean).pop() ?? rootPath;
    this.db
      .prepare('INSERT INTO repositories (id, name, root_path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, rootPath, defaultBranch, Date.now());
    return { id };
  }

  getRepository(id: string): { id: string; rootPath: string; defaultBranch: string } | undefined {
    const r = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id as string, rootPath: r.root_path as string, defaultBranch: r.default_branch as string } : undefined;
  }

  insertTask(t: NewTask): TaskRecord {
    this.db
      .prepare(
        `INSERT INTO tasks (id, repo_id, parent_task_id, agent_id, role, title, prompt, base_branch, branch_name,
           worktree_path, approval_policy, verify_command, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(
        t.id, t.repoId, t.parentTaskId, t.agentId, t.role ?? 'worker', t.title, t.prompt, t.baseBranch,
        t.branchName, t.worktreePath, t.approvalPolicy, t.verifyCommand, Date.now(),
      );
    return this.getTask(t.id)!;
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }

  listTasks(filter: { status?: TaskStatus[]; repoId?: string } = {}): TaskRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (filter.repoId) {
      where.push('repo_id = ?');
      args.push(filter.repoId);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toTask);
  }

  updateTask(id: string, patch: Partial<Pick<TaskRecord, 'status' | 'exitCode' | 'verifyOutput' | 'errorMessage' | 'sessionId' | 'startedAt' | 'completedAt'>>): void {
    const cols: Record<string, string> = {
      status: 'status', exitCode: 'exit_code', verifyOutput: 'verify_output', errorMessage: 'error_message',
      sessionId: 'session_id', startedAt: 'started_at', completedAt: 'completed_at',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${cols[k]} = ?`);
      args.push(v);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  appendLog(taskId: string, stream: 'pty' | 'json_event' | 'system' | 'verify', payload: string): void {
    this.db.prepare('INSERT INTO task_logs (task_id, stream, payload, created_at) VALUES (?, ?, ?, ?)').run(taskId, stream, payload, Date.now());
  }

  getLogs(taskId: string, afterId = 0, limit = 1000): Array<{ id: number; stream: string; payload: string; createdAt: number }> {
    return (
      this.db
        .prepare('SELECT * FROM task_logs WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(taskId, afterId, limit) as Row[]
    ).map((r) => ({ id: r.id as number, stream: r.stream as string, payload: r.payload as string, createdAt: r.created_at as number }));
  }

  insertApproval(a: Omit<ApprovalRecord, 'status' | 'resolvedBy' | 'createdAt' | 'resolvedAt'>): ApprovalRecord {
    this.db
      .prepare('INSERT INTO approval_requests (id, task_id, agent_id, tool_name, summary, raw_payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.taskId, a.agentId, a.toolName, a.summary, a.rawPayload, 'pending', Date.now());
    return this.getApproval(a.id)!;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const r = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as Row | undefined;
    return r ? toApproval(r) : undefined;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRecord[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 200').all();
    return (rows as Row[]).map(toApproval);
  }

  /** Only resolves a still-pending request; returns false if it was already resolved. */
  resolveApproval(id: string, status: Exclude<ApprovalStatus, 'pending'>, by: ApprovalActor): boolean {
    const res = this.db
      .prepare("UPDATE approval_requests SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, by, Date.now(), id);
    return res.changes > 0;
  }

  pendingApprovalCount(taskId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE task_id = ? AND status = 'pending'").get(taskId) as Row;
    return r.n as number;
  }

  recordUsage(agentId: string, taskId: string | null, eventType: 'task_started' | 'task_completed' | 'rate_limited', durationMs?: number, retryAfter?: number): void {
    this.db
      .prepare('INSERT INTO agent_usage_events (agent_id, task_id, event_type, duration_ms, retry_after_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(agentId, taskId, eventType, durationMs ?? null, retryAfter ?? null, Date.now());
  }

  /** Latest unexpired rate-limit event for an agent, used by agent.health. */
  activeRateLimit(agentId: string): { resetAt: number } | null {
    const r = this.db
      .prepare("SELECT created_at, retry_after_seconds FROM agent_usage_events WHERE agent_id = ? AND event_type = 'rate_limited' ORDER BY id DESC LIMIT 1")
      .get(agentId) as Row | undefined;
    if (!r || r.retry_after_seconds == null) return null;
    const resetAt = (r.created_at as number) + (r.retry_after_seconds as number) * 1000;
    return resetAt > Date.now() ? { resetAt } : null;
  }
}
