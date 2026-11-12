import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, ParsedAgentEvent, SpawnContext } from './types.js';
import { detectRateLimitInJsonl, probeBinary, tryParseJson } from './util.js';

export const HOOK_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'aggregator-hook.mjs');
const HOOK_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit';

export interface ClaudeAdapterOptions {
  command?: string;
  /** Arguments placed before the adapter's own (lets tests run `node mock-claude.mjs`). */
  baseArgs?: string[];
  nodeBinary?: string;
}

/**
 * Headless `claude -p --output-format stream-json`. Tool approvals are gated by a PreToolUse hook that is
 * injected into the worktree's `.claude/settings.local.json` and talks to the daemon with a per-task token.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly supportsNativeResume = true;
  readonly supportsApprovalGating = true;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly nodeBinary: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.baseArgs = opts.baseArgs ?? [];
    this.nodeBinary = opts.nodeBinary ?? process.execPath;
  }

  detectInstalled() {
    return probeBinary(this.command);
  }

  async prepareWorktree(ctx: SpawnContext): Promise<void> {
    const dir = join(ctx.worktreePath, '.claude');
    await mkdir(dir, { recursive: true });
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: HOOK_MATCHER,
            hooks: [{ type: 'command', command: `"${this.nodeBinary}" "${HOOK_SCRIPT_PATH}"` }],
          },
        ],
      },
    };
    await writeFile(join(dir, 'settings.local.json'), JSON.stringify(settings, null, 2));
  }

  buildCommand(ctx: SpawnContext) {
    const args = [...this.baseArgs, '-p', ctx.prompt, '--output-format', 'stream-json', '--verbose'];
    if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
    return { command: this.command, args, usePty: false };
  }

  parseOutputChunk(raw: string): ParsedAgentEvent[] {
    const events: ParsedAgentEvent[] = [];
    for (const line of raw.split('\n')) {
      const obj = tryParseJson(line);
      if (!obj) continue;
      if (typeof obj.session_id === 'string' && (obj.type === 'system' || obj.type === 'result')) {
        events.push({ type: 'session', sessionId: obj.session_id });
      }
      if (obj.type === 'assistant') {
        const content = (obj.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') events.push({ type: 'message', text: block.text });
          if (block.type === 'tool_use') {
            events.push({ type: 'tool', name: String(block.name), summary: JSON.stringify(block.input ?? {}).slice(0, 200) });
          }
        }
      }
    }
    return events;
  }

  detectRateLimit(raw: string) {
    return detectRateLimitInJsonl(raw, (o) => o.type === 'result' && o.is_error === true);
  }
}
