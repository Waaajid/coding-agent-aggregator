import { z } from 'zod';
import type { AgentId } from '@aggregator/shared';
import type { AgentAdapter, SpawnContext } from './types.js';
import { parseRetryAfter, probeBinary, RATE_LIMIT_RE, stripAnsi } from './util.js';

export const CustomAgentConfigSchema = z.object({
  displayName: z.string().optional(),
  command: z.string().min(1),
  argsTemplate: z.array(z.string()).default([]),
  /** Used instead of `argsTemplate` when continuing a previous session; enables native resume. */
  resumeArgsTemplate: z.array(z.string()).optional(),
  usePty: z.boolean().default(true),
  versionArgs: z.array(z.string()).default(['--version']),
  rateLimitRegex: z.string().optional(),
  /** Matches an approval prompt in PTY output; capture group 1 (if any) is the action summary. */
  approvalRegex: z.string().optional(),
  approveInput: z.string().default('y\r'),
  denyInput: z.string().default('n\r'),
  env: z.record(z.string()).default({}),
});
export type CustomAgentConfig = z.infer<typeof CustomAgentConfigSchema>;
export const AgentsFileSchema = z.record(CustomAgentConfigSchema);

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

/** Config-driven adapter for Antigravity, Gemini CLI and anything else with a command line. */
export class CustomAdapter implements AgentAdapter {
  readonly supportsNativeResume: boolean;
  readonly supportsApprovalGating: boolean;
  readonly displayName: string;
  private readonly rateLimitRe: RegExp;
  private readonly approvalRe?: RegExp;

  constructor(
    readonly id: AgentId,
    private readonly cfg: CustomAgentConfig,
  ) {
    this.displayName = cfg.displayName ?? id;
    this.supportsNativeResume = Boolean(cfg.resumeArgsTemplate);
    this.supportsApprovalGating = Boolean(cfg.approvalRegex) && cfg.usePty;
    this.rateLimitRe = cfg.rateLimitRegex ? new RegExp(cfg.rateLimitRegex, 'i') : RATE_LIMIT_RE;
    this.approvalRe = cfg.approvalRegex ? new RegExp(cfg.approvalRegex, 'i') : undefined;
  }

  detectInstalled() {
    return probeBinary(this.cfg.command, this.cfg.versionArgs);
  }

  buildCommand(ctx: SpawnContext) {
    const vars = {
      worktreePath: ctx.worktreePath,
      prompt: ctx.prompt,
      taskId: ctx.taskId,
      sessionId: ctx.resumeSessionId ?? '',
    };
    const template = ctx.resumeSessionId && this.cfg.resumeArgsTemplate ? this.cfg.resumeArgsTemplate : this.cfg.argsTemplate;
    return { command: this.cfg.command, args: template.map((a) => render(a, vars)), usePty: this.cfg.usePty };
  }

  detectRateLimit(raw: string) {
    const text = stripAnsi(raw);
    return this.rateLimitRe.test(text)
      ? { isRateLimited: true, retryAfterSeconds: parseRetryAfter(text) }
      : { isRateLimited: false };
  }

  detectApprovalPrompt(raw: string) {
    if (!this.approvalRe) return null;
    const m = this.approvalRe.exec(stripAnsi(raw));
    return m ? { detected: true, actionSummary: (m[1] ?? m[0]).trim() } : null;
  }

  approvalInput(decision: 'approve' | 'deny'): string {
    return decision === 'approve' ? this.cfg.approveInput : this.cfg.denyInput;
  }

  get extraEnv(): Record<string, string> {
    return this.cfg.env;
  }
}
