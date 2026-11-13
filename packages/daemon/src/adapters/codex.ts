import type { AgentAdapter, ParsedAgentEvent, SpawnContext } from './types.js';
import { detectRateLimitInJsonl, probeBinary, tryParseJson } from './util.js';

export interface CodexAdapterOptions {
  command?: string;
  baseArgs?: string[];
}

/**
 * Headless `codex exec --json`. The run is confined by Codex's own workspace-write sandbox (`--full-auto`);
 * headless mode has no approval prompts to intercept, so `supportsApprovalGating` is false. To gate Codex
 * through the Approval Queue, override `codex` in ~/.aggregator/agents.json with a PTY command and an
 * `approvalRegex`.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'OpenAI Codex CLI';
  readonly supportsNativeResume = false;
  readonly supportsApprovalGating = false;
  private readonly command: string;
  private readonly baseArgs: string[];

  constructor(opts: CodexAdapterOptions = {}) {
    this.command = opts.command ?? 'codex';
    this.baseArgs = opts.baseArgs ?? [];
  }

  detectInstalled() {
    return probeBinary(this.command);
  }

  buildCommand(ctx: SpawnContext) {
    return {
      command: this.command,
      args: [...this.baseArgs, 'exec', '--json', '--full-auto', ctx.prompt],
      usePty: false,
    };
  }

  parseOutputChunk(raw: string): ParsedAgentEvent[] {
    const events: ParsedAgentEvent[] = [];
    for (const line of raw.split('\n')) {
      const obj = tryParseJson(line);
      if (!obj) continue;
      const msg = (obj.msg ?? obj) as Record<string, unknown>;
      if (typeof msg.type === 'string' && msg.type.includes('message') && typeof msg.message === 'string') {
        events.push({ type: 'message', text: msg.message });
      }
    }
    return events;
  }

  detectRateLimit(raw: string) {
    return detectRateLimitInJsonl(raw, (o) => {
      const t = String((o.msg as { type?: string } | undefined)?.type ?? o.type ?? '');
      return t === 'error' || t === 'turn.failed' || t === 'stream_error';
    });
  }
}
