import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHarness, waitUntil, type Harness } from '../../daemon/test/harness.js';
import { cleanup, makeRepo } from '../../daemon/test/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(pkgDir, 'dist', 'index.mjs');

let h: Harness;
let client: Client;
const repo = makeRepo();

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = res.content[0]!.text;
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) };
};

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], { cwd: pkgDir, stdio: 'pipe' });
  h = await startHarness();
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH ?? '', AGGREGATOR_URL: h.daemon.url, AGGREGATOR_MANAGER_TOKEN: h.config.managerToken },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await h?.stop();
  cleanup(repo);
});

describe('MCP server', () => {
  it('exposes the five spec tools plus agent_health', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['agent_health', 'check_task_status', 'delegate_task', 'merge_worktree', 'read_worker_diff', 'send_feedback'],
    );
    const delegate = tools.find((t) => t.name === 'delegate_task')!;
    expect(delegate.inputSchema.required).toEqual(expect.arrayContaining(['repo_path', 'agent', 'title', 'prompt']));
  });

  it('delegates two parallel tasks, polls them, reads diffs, and requests merges that wait for a human', async () => {
    const a = (await call('delegate_task', { repo_path: repo, agent: 'codex', title: 'task-a', prompt: 'WRITE a.out A;;SLEEP 300' })).json();
    const b = (await call('delegate_task', { repo_path: repo, agent: 'codex', title: 'task-b', prompt: 'WRITE b.out B;;SLEEP 300', verify_command: 'test -f b.out' })).json();
    expect(a).toMatchObject({ status: 'running' });
    expect(a.branch).toBe(`agent/codex/${a.task_id}`);
    expect(a.task_id).not.toBe(b.task_id);

    const statuses = (await call('check_task_status', { task_ids: [a.task_id, b.task_id], wait_seconds: 10 })).json();
    expect(statuses).toHaveLength(2);
    await h.waitForTask(a.task_id, ['completed']);
    await h.waitForTask(b.task_id, ['completed']);

    const diff = (await call('read_worker_diff', { task_id: a.task_id })).text;
    expect(diff).toContain('a.out (+1 -0)');
    expect(diff).toContain('+A');
    expect((await call('read_worker_diff', { task_id: a.task_id, file_filter: 'nope.txt' })).text).toContain('(no changes)');

    const merge = (await call('merge_worktree', { task_id: a.task_id })).json();
    expect(merge.status).toBe('pending_approval');
    expect(existsSync(join(repo, 'a.out'))).toBe(false);

    await h.admin('POST', `/api/approvals/${merge.approvalId}/resolve`, { decision: 'approve' });
    await waitUntil(async () => (await h.admin('GET', `/api/tasks/${a.task_id}`)).body.task.status === 'merged', 10_000, 'merged');
    expect(readFileSync(join(repo, 'a.out'), 'utf8')).toBe('A\n');
  });

  it('sends feedback and reports daemon errors as tool errors, not protocol failures', async () => {
    const t = (await call('delegate_task', { repo_path: repo, agent: 'claude', title: 'fb', prompt: 'WRITE fb.txt 1', approval_policy: 'auto_edit' })).json();
    await h.waitForTask(t.task_id, ['completed']);
    const fb = (await call('send_feedback', { task_id: t.task_id, message: 'WRITE fb2.txt 2' })).json();
    expect(fb.task_id).toBe(t.task_id);
    await h.waitForTask(t.task_id, ['completed']);

    const missing = await call('read_worker_diff', { task_id: 'tsk_missing' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('task not found');
    const bad = await call('delegate_task', { repo_path: '/tmp', agent: 'codex', title: 'x', prompt: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('not a git repository');

    const health = (await call('agent_health', {})).json();
    expect(health.map((x: any) => x.id)).toEqual(expect.arrayContaining(['claude', 'codex']));
  });

  it('cannot approve its own work: the manager credential is rejected by the approval endpoint', async () => {
    expect((await h.manager('POST', '/api/approvals/apr_x/resolve', { decision: 'approve' })).status).toBe(403);
  });

  it('--print-config emits a ready-to-use mcpServers snippet', () => {
    const out = execFileSync(process.execPath, [entry, '--print-config'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(JSON.parse(out).mcpServers.aggregator).toMatchObject({ command: process.execPath, args: [entry] });
  });
});
