import type { AgentId, ApprovalPolicy } from '@aggregator/shared';

export type { AgentId };

export interface SpawnContext {
  taskId: string;
  worktreePath: string;
  prompt: string;
  approvalPolicy: ApprovalPolicy;
  env: Record<string, string>;
  /** Set when continuing an earlier run of an adapter with `supportsNativeResume`. */
  resumeSessionId?: string;
}

export type ParsedAgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; summary: string };

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** True when `resumeSessionId` continues the previous conversation; otherwise the daemon replays context in the prompt. */
  supportsNativeResume: boolean;
  /** True when tool/shell approvals can be intercepted (hook or prompt detection). */
  supportsApprovalGating: boolean;
  detectInstalled(): Promise<{ installed: boolean; version?: string; binaryPath?: string }>;
  /** Write per-worktree files the agent needs (e.g. approval hook settings). */
  prepareWorktree?(ctx: SpawnContext): Promise<void>;
  buildCommand(ctx: SpawnContext): { command: string; args: string[]; usePty: boolean };
  /** Receives complete lines for piped agents, raw (ANSI-stripped) text for PTY agents. */
  parseOutputChunk?(raw: string): ParsedAgentEvent[];
  detectRateLimit(raw: string): { isRateLimited: boolean; retryAfterSeconds?: number };
  detectApprovalPrompt?(raw: string): { detected: boolean; actionSummary: string } | null;
  /** Keystrokes that answer a detected PTY approval prompt. */
  approvalInput?(decision: 'approve' | 'deny'): string;
  /** Extra environment for the spawned process. */
  readonly extraEnv?: Record<string, string>;
}
