import type { ApprovalActor, ApprovalRecord, TaskRecord } from '@aggregator/shared';
import { newId } from '@aggregator/shared';
import type { Repo } from './db/repo.js';
import type { Bus } from './events.js';
import { classifyTool, decidePolicy } from './policy.js';

export interface ApprovalRequestInput {
  task: TaskRecord;
  toolName: string;
  summary: string;
  rawPayload: unknown;
  command?: string;
  filePath?: string;
  /** Skip the task's policy and always ask a human (e.g. merges). */
  forceAsk?: boolean;
}

export class ApprovalService {
  private readonly waiters = new Map<string, Set<(a: ApprovalRecord) => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly remembered = new Set<string>();

  constructor(
    private readonly repo: Repo,
    private readonly bus: Bus,
    private readonly timeoutMs: number,
  ) {}

  /** Records the request, then either settles it by policy or leaves it pending for a human. */
  create(input: ApprovalRequestInput): ApprovalRecord {
    const { task } = input;
    const approval = this.repo.insertApproval({
      id: newId('apr'),
      taskId: task.id,
      agentId: task.agentId,
      toolName: input.toolName,
      summary: input.summary,
      rawPayload: JSON.stringify(input.rawPayload ?? null),
    });

    const key = this.rememberKey(task.id, input);
    const auto =
      !input.forceAsk &&
      (this.remembered.has(key) ||
        decidePolicy({
          policy: task.approvalPolicy,
          toolName: input.toolName,
          worktreePath: task.worktreePath,
          command: input.command,
          filePath: input.filePath,
        }) === 'allow');
    if (auto) return this.settle(approval, 'approved', 'policy');

    this.bus.emit('approval.requested', approval);
    const timer = setTimeout(() => this.resolve(approval.id, 'expired', 'policy'), this.timeoutMs);
    timer.unref();
    this.timers.set(approval.id, timer);
    return approval;
  }

  resolve(id: string, decision: 'approve' | 'deny' | 'expired', by: ApprovalActor, rememberForTask = false): ApprovalRecord | undefined {
    const approval = this.repo.getApproval(id);
    if (!approval || approval.status !== 'pending') return approval;
    const status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'expired';
    if (rememberForTask && status === 'approved') this.remembered.add(this.rememberKeyFromRecord(approval));
    return this.settle(approval, status, by);
  }

  /** Resolves when the approval is no longer pending, or returns it still-pending after `ms`. */
  wait(id: string, ms: number): Promise<ApprovalRecord> {
    const current = this.repo.getApproval(id);
    if (!current) return Promise.reject(new Error('approval not found'));
    if (current.status !== 'pending') return Promise.resolve(current);
    return new Promise((resolvePromise) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (a: ApprovalRecord) => {
        clearTimeout(t);
        set.delete(done);
        resolvePromise(a);
      };
      const t = setTimeout(() => done(this.repo.getApproval(id)!), ms);
      set.add(done);
    });
  }

  /** Denies everything still pending for a task (cancel / exit). */
  expireForTask(taskId: string): void {
    for (const a of this.repo.listApprovals('pending')) {
      if (a.taskId === taskId) this.resolve(a.id, 'expired', 'policy');
    }
  }

  private settle(approval: ApprovalRecord, status: 'approved' | 'denied' | 'expired', by: ApprovalActor): ApprovalRecord {
    this.repo.resolveApproval(approval.id, status, by);
    const timer = this.timers.get(approval.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(approval.id);
    const updated = this.repo.getApproval(approval.id)!;
    for (const w of [...(this.waiters.get(approval.id) ?? [])]) w(updated);
    this.waiters.delete(approval.id);
    if (by !== 'policy' || status === 'expired') this.bus.emit('approval.resolved', updated);
    return updated;
  }

  // Shell approvals are remembered per exact command, everything else per tool.
  private rememberKey(taskId: string, input: { toolName: string; command?: string }): string {
    return classifyTool(input.toolName) === 'shell' ? `${taskId}|shell|${input.command ?? ''}` : `${taskId}|${input.toolName}`;
  }

  private rememberKeyFromRecord(a: ApprovalRecord): string {
    let command: string | undefined;
    try {
      command = (JSON.parse(a.rawPayload) as { command?: string } | null)?.command;
    } catch {
      /* raw payload is informational only */
    }
    return this.rememberKey(a.taskId, { toolName: a.toolName, command });
  }
}
