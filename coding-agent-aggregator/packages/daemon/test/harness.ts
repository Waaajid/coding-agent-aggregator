import { AdapterRegistry } from '../src/adapters/registry.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CustomAdapter } from '../src/adapters/custom.js';
import { loadConfig, type DaemonConfig } from '../src/config.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import { cleanup, makeTempDir } from './helpers.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
export const MOCK_AGENT = join(fixtures, 'mock-agent.mjs');
export const MOCK_CLAUDE = join(fixtures, 'mock-claude.mjs');

export interface Harness {
  daemon: Daemon;
  config: DaemonConfig;
  home: string;
  call(method: 'GET' | 'POST', path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
  admin(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }>;
  manager(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }>;
  waitForTask(id: string, statuses: string[], timeoutMs?: number): Promise<any>;
  stop(): Promise<void>;
}

/** Real daemon on an ephemeral port; `claude` is a mock stream-json agent, `codex`/`antigravity` are mock CLIs. */
export async function startHarness(overrides: Partial<DaemonConfig> = {}): Promise<Harness> {
  const home = makeTempDir('agg-home-');
  const config = loadConfig({}, { home, port: 0, approvalTimeoutMs: 60_000, ...overrides });
  const registry = new AdapterRegistry({
    claude: new ClaudeAdapter({ command: process.execPath, baseArgs: [MOCK_CLAUDE] }),
    codex: new CustomAdapter('codex', {
      command: process.execPath,
      argsTemplate: [MOCK_AGENT, '--task', '{{prompt}}'],
      usePty: false,
      versionArgs: ['--version'],
      env: {},
      approveInput: 'y\r',
      denyInput: 'n\r',
    }),
    antigravity: new CustomAdapter('antigravity', {
      command: process.execPath,
      argsTemplate: [MOCK_AGENT, '--task', '{{prompt}}'],
      usePty: true,
      versionArgs: ['--version'],
      approvalRegex: 'Allow command: (.+?) \\?',
      rateLimitRegex: '429|rate limit',
      env: {},
      approveInput: 'y\r',
      denyInput: 'n\r',
    }),
  });
  const daemon = await startDaemon(config, {
    registry,
    manager: { command: process.execPath, baseArgs: [MOCK_CLAUDE], mcpEntry: MOCK_CLAUDE },
  });

  const call: Harness['call'] = async (method, path, body, token) => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const h: Harness = {
    daemon,
    config,
    home,
    call,
    admin: (m, p, b) => call(m, p, b, config.token),
    manager: (m, p, b) => call(m, p, b, config.managerToken),
    async waitForTask(id, statuses, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      let last: any;
      while (Date.now() < deadline) {
        last = (await h.admin('GET', `/api/tasks/${id}`)).body.task;
        if (statuses.includes(last.status)) return last;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`task ${id} did not reach ${statuses.join('|')} (last: ${last?.status}, error: ${last?.errorMessage})`);
    },
    async stop() {
      await daemon.close();
      cleanup(home);
    },
  };
  return h;
}

export async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
