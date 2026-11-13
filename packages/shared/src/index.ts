import { z } from 'zod';
import { randomBytes } from 'node:crypto';

export * from './rpc.js';

export const AGENT_IDS = ['claude', 'codex', 'antigravity', 'gemini', 'custom'] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const APPROVAL_POLICIES = ['auto_edit', 'ask_shell', 'ask_all'] as const;
export const ApprovalPolicySchema = z.enum(APPROVAL_POLICIES);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'verifying',
  'completed',
  'failed',
  'rate_limited',
  'cancelled',
  'merged',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'rate_limited', 'cancelled', 'merged'];

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalActor = 'web_ui' | 'mobile_ui' | 'manager_agent' | 'policy';

export const CreateTaskInputSchema = z.object({
  repoPath: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
  agent: AgentIdSchema,
  title: z.string().min(1).max(80),
  prompt: z.string().min(1),
  verifyCommand: z.string().optional(),
  approvalPolicy: ApprovalPolicySchema.default('ask_shell'),
  parentTaskId: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const ResolveApprovalInputSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  rememberForTask: z.boolean().optional(),
});
export type ResolveApprovalInput = z.infer<typeof ResolveApprovalInputSchema>;

export const MergeInputSchema = z.object({
  targetBranch: z.string().min(1).optional(),
  squash: z.boolean().default(true),
  commitMessage: z.string().optional(),
});
export type MergeInput = z.infer<typeof MergeInputSchema>;

export interface TaskRecord {
  id: string;
  repoId: string;
  parentTaskId: string | null;
  agentId: AgentId;
  role: 'manager' | 'worker';
  title: string;
  prompt: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  approvalPolicy: ApprovalPolicy;
  verifyCommand: string | null;
  status: TaskStatus;
  exitCode: number | null;
  verifyOutput: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  agentId: AgentId;
  toolName: string;
  summary: string;
  rawPayload: string;
  status: ApprovalStatus;
  resolvedBy: ApprovalActor | null;
  createdAt: number;
  resolvedAt: number | null;
}

export type MergeResult =
  | { status: 'merged'; commit: string }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'target_dirty'; message: string };

/** Sortable, URL-safe id: `<prefix>_<10 hex chars of time><10 hex chars random>` */
export function newId(prefix: string): string {
  const time = Date.now().toString(16).padStart(12, '0');
  return `${prefix}_${time}${randomBytes(5).toString('hex')}`;
}
