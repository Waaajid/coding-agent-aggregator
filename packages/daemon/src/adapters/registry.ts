import { existsSync, readFileSync } from 'node:fs';
import type { AgentId } from '@aggregator/shared';
import { AGENT_IDS } from '@aggregator/shared';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { AgentsFileSchema, CustomAdapter, type CustomAgentConfig } from './custom.js';
import type { AgentAdapter } from './types.js';

const DEFAULT_CUSTOM: Record<string, unknown> = {
  antigravity: {
    displayName: 'Antigravity',
    command: 'antigravity',
    argsTemplate: ['run', '--cwd', '{{worktreePath}}', '--task', '{{prompt}}'],
    usePty: true,
    rateLimitRegex: '(rate limit|429|quota exceeded)',
  },
  gemini: {
    displayName: 'Gemini CLI',
    command: 'gemini',
    argsTemplate: ['-p', '{{prompt}}'],
    usePty: false,
  },
};

export class AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  constructor(overrides: Partial<Record<AgentId, AgentAdapter>> = {}) {
    this.adapters.set('claude', new ClaudeAdapter());
    this.adapters.set('codex', new CodexAdapter());
    for (const [id, cfg] of Object.entries(AgentsFileSchema.parse(DEFAULT_CUSTOM))) this.addCustom(id, cfg);
    for (const [id, adapter] of Object.entries(overrides)) this.adapters.set(id as AgentId, adapter);
  }

  /** Built-ins plus `~/.aggregator/agents.json` (entries there replace built-ins with the same id). */
  static fromFile(path: string): AdapterRegistry {
    const registry = new AdapterRegistry();
    if (!existsSync(path)) return registry;
    const parsed = AgentsFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    for (const [id, cfg] of Object.entries(parsed)) registry.addCustom(id, cfg);
    return registry;
  }

  private addCustom(id: string, cfg: CustomAgentConfig): void {
    if (!(AGENT_IDS as readonly string[]).includes(id)) {
      throw new Error(`agents.json: unknown agent id "${id}" (expected one of ${AGENT_IDS.join(', ')})`);
    }
    this.adapters.set(id as AgentId, new CustomAdapter(id as AgentId, cfg));
  }

  get(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
