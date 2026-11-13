// `npm run demo`: a self-contained playground. Mock agents, a mock manager and a throwaway git repo, so the whole
// control plane can be explored with no agent CLIs installed and no API usage.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CustomAdapter } from '../src/adapters/custom.js';
import { loadConfig } from '../src/config.js';
import { startDaemon } from '../src/daemon.js';
import { makeRepo, makeTempDir } from '../test/helpers.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'test', 'fixtures');
const mockAgent = join(fixtures, 'mock-agent.mjs');
const mockClaude = join(fixtures, 'mock-claude.mjs');
const demoManager = join(fixtures, 'demo-manager.mjs');

const home = makeTempDir('agg-demo-home-');
const repo = makeRepo();
const config = loadConfig(process.env, { home, port: Number(process.env.AGGREGATOR_PORT ?? 4173) });

const base = { command: process.execPath, usePty: false, versionArgs: ['--version'], env: {}, approveInput: 'y\r', denyInput: 'n\r' };
const registry = new AdapterRegistry({
  claude: new ClaudeAdapter({ command: process.execPath, baseArgs: [mockClaude] }),
  codex: new CustomAdapter('codex', { ...base, displayName: 'Codex (demo)', argsTemplate: [mockAgent, '--task', '{{prompt}}'] }),
  antigravity: new CustomAdapter('antigravity', {
    ...base, displayName: 'Antigravity (demo)', usePty: true, argsTemplate: [mockAgent, '--task', '{{prompt}}'],
    approvalRegex: 'Allow command: (.+?) \\?', rateLimitRegex: '429|rate limit',
  }),
});

const daemon = await startDaemon(config, { registry, manager: { command: process.execPath, baseArgs: [demoManager], mcpEntry: demoManager } }).catch((err: NodeJS.ErrnoException) => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use. Try: AGGREGATOR_PORT=${config.port + 1} npm run demo\n`);
    process.exit(1);
  }
  throw err;
});

const seed = async (agent: string, title: string, prompt: string, extra: Record<string, unknown> = {}) =>
  fetch(`${daemon.url}/api/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: repo, agent, title, prompt, ...extra }),
  });

await seed('claude', 'add-docs', 'SAY reading the codebase;;WRITE docs.md hello;;BASH npm publish;;SAY all done', { approvalPolicy: 'ask_shell' });
await seed('antigravity', 'refactor-utils', 'SAY analysing;;SLEEP 1500;;ASK rm -rf build ;;WRITE utils.txt refactored;;SLEEP 500', { approvalPolicy: 'ask_shell' });
await seed('codex', 'write-tests', 'SAY writing tests;;WRITE tests.txt ok;;SLEEP 3000', { verifyCommand: 'test -f tests.txt && echo tests present' });
await seed('codex', 'flaky-task', 'SAY about to fail;;EXIT 2');

console.log(`
Demo running (mock agents, throwaway repo: ${repo})
  Open:  ${daemon.url}/#token=${config.token}

  • Approve/deny the two waiting tasks, review the diff of "write-tests", then merge it.
  • In the Manager chat, try "plan and delegate the work".
  Ctrl+C to stop; everything is temporary.
`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void daemon.close().finally(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
