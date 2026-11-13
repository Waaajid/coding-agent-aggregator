import type { ApprovalRecord, TaskRecord, TaskStatus } from '@aggregator/shared';

export type { ApprovalRecord, TaskRecord, TaskStatus };

export interface AgentHealth {
  id: string;
  displayName: string;
  installed: boolean;
  version?: string;
  supportsApprovalGating: boolean;
  supportsNativeResume: boolean;
  rateLimitedUntil: number | null;
}

export interface Chat {
  id: string;
  repoPath: string;
  title: string;
  sessionId: string | null;
  createdAt: number;
  busy: boolean;
}

export interface ChatMessage {
  id: number;
  chatId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt: number;
}

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffResponse {
  task_id: string;
  branch: string;
  base_branch: string;
  files: DiffFile[];
  truncated: boolean;
  total_lines: number;
  diff: string;
}

export type MergeOutcome =
  | { status: 'merged'; commit: string }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'target_dirty'; message: string }
  | { status: 'pending_approval'; approvalId: string };

export interface ActivityItem {
  id: number;
  at: number;
  kind: 'info' | 'success' | 'warn' | 'error' | 'approval';
  text: string;
  taskId?: string;
}
