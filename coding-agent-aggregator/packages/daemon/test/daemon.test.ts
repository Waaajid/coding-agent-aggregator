import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, existsSync, makeRepo, readFileSync, sh } from './helpers.js';
import { statSync } from 'node:fs';
import { startHarness, waitUntil, type Harness } from './harness.js';
import { loadConfig } from '../src/config.js';
import { startDaemon } from '../src/daemon.js';
import { join } from 'node:path';

let h: Harness;
const repos: string[] = [];
const newRepo = () => {
  const r = makeRepo();
  repos.push(r);
  return r;
};

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.stop();
  cleanup(...repos);
});

const create = async (repoPath: string, agent: string, prompt: string, extra: Record<string, unknown> = {}) => {
  const res = await h.admin('POST', '/api/tasks', { repoPath, agent, title: 'task', prompt, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { task: any; warnings: string[] };
};

describe('security gate', () => {
  it('rejects missing/invalid tokens, foreign Host headers and foreign Origins', async () => {
    expect((await h.call('GET', '/api/tasks')).status).toBe(401);
    expect((await h.call('GET', '/api/tasks', undefined, 'nope')).status).toBe(401);
    expect((await h.call('GET', '/healthz')).status).toBe(200);

    const rebinding = await h.daemon.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: 'evil.example.com', authorization: `Bearer ${h.config.token}` } });
    expect(rebinding.statusCode).toBe(403);
    const csrf = await h.daemon.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: '127.0.0.1', origin: 'https://evil.example.com', authorization: `Bearer ${h.config.token}` } });
    expect(csrf.statusCode).toBe(403);
  });

  it('manager token can orchestrate but cannot resolve approvals; hook endpoints need a per-task token', async () => {
    expect((await h.manager('GET', '/api/tasks')).status).toBe(200);
    expect((await h.manager('POST', '/api/approvals/apr_x/resolve', { decision: 'approve' })).status).toBe(403);
    expect((await h.call('POST', '/internal/approvals', { taskId: 't', toolName: 'Bash', toolInput: {} }, h.config.token)).status).toBe(401);
    expect((await h.call('POST', '/internal/approvals', { taskId: 't', toolName: 'Bash', toolInput: {} }, h.config.managerToken)).status).toBe(401);
  });

  it('validates input and unknown repos/branches', async () => {
    expect((await h.admin('POST', '/api/tasks', { agent: 'codex' })).status).toBe(400);
    expect((await h.admin('POST', '/api/tasks', { repoPath: '/tmp', agent: 'codex', title: 't', prompt: 'p' })).status).toBe(400);
    const repo = newRepo();
    expect((await h.admin('POST', '/api/tasks', { repoPath: repo, baseBranch: 'nope', agent: 'codex', title: 't', prompt: 'p' })).status).toBe(400);
    expect((await h.admin('GET', '/api/tasks/tsk_missing')).status).toBe(404);
  });
});

describe('headless worker lifecycle', () => {
  it('runs in an isolated worktree, auto-commits, reports status/diff, and merges via human action', async () => {
    const repo = newRepo();
    const { task, warnings } = await create(repo, 'codex', 'WRITE out.txt hello;;SAY done', { approvalPolicy: 'auto_edit' });
    expect(warnings).toEqual([]);
    expect(task.branchName).toBe(`agent/codex/${task.id}`);

    const done = await h.waitForTask(task.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    expect(done.exitCode).toBe(0);
    expect(existsSync(join(repo, 'out.txt'))).toBe(false); // main checkout untouched
    expect(readFileSync(join(task.worktreePath, 'out.txt'), 'utf8')).toBe('hello\n');
    expect(sh(task.worktreePath, 'git', 'status', '--porcelain').trim()).toBe(''); // auto-committed

    const diff = (await h.admin('GET', `/api/tasks/${task.id}/diff`)).body;
    expect(diff.files.map((f: any) => f.path)).toEqual(['out.txt']);
    expect(diff.diff).toContain('+hello');

    const status = (await h.manager('GET', `/api/tasks/status?ids=${task.id}`)).body.tasks[0];
    expect(status).toMatchObject({ task_id: task.id, agent: 'codex', status: 'completed', exit_code: 0, changed_files_count: 1 });

    const logs = (await h.admin('GET', `/api/tasks/${task.id}/logs`)).body.logs;
    expect(logs.map((l: any) => l.payload).join('')).toContain('wrote out.txt');

    const merged = await h.admin('POST', `/api/tasks/${task.id}/merge`, { squash: true });
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('merged');
    expect(readFileSync(join(repo, 'out.txt'), 'utf8')).toBe('hello\n');
    expect((await h.waitForTask(task.id, ['merged'])).status).toBe('merged');
    expect(existsSync(task.worktreePath)).toBe(false);
  });

  it('runs two workers in parallel on separate branches and merges both', async () => {
    const repo = newRepo();
    const a = (await create(repo, 'codex', 'WRITE a.out A;;SLEEP 300')).task;
    const b = (await create(repo, 'codex', 'WRITE b.out B;;SLEEP 300')).task;
    await Promise.all([h.waitForTask(a.id, ['completed']), h.waitForTask(b.id, ['completed'])]);
    expect(existsSync(join(b.worktreePath, 'a.out'))).toBe(false);
    for (const t of [a, b]) expect((await h.admin('POST', `/api/tasks/${t.id}/merge`, {})).body.status).toBe('merged');
    expect(readFileSync(join(repo, 'a.out'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(repo, 'b.out'), 'utf8')).toBe('B\n');
  });

  it('marks non-zero exits failed and supports retry', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'SAY boom;;EXIT 3');
    const failed = await h.waitForTask(task.id, ['failed']);
    expect(failed.exitCode).toBe(3);
    expect((await h.admin('POST', `/api/tasks/${task.id}/retry`)).status).toBe(200);
    expect((await h.waitForTask(task.id, ['failed'])).exitCode).toBe(3);
    expect((await h.admin('POST', `/api/tasks/${task.id}/retry`)).status).toBe(200);
  });

  it('runs verify_command after the agent and fails the task when verification fails', async () => {
    const repo = newRepo();
    const ok = (await create(repo, 'codex', 'WRITE v.txt 1', { verifyCommand: 'test -f v.txt && echo verified' })).task;
    const okDone = await h.waitForTask(ok.id, ['completed', 'failed']);
    expect(okDone.status).toBe('completed');
    expect(okDone.verifyOutput).toContain('verified');

    const bad = (await create(repo, 'codex', 'SAY nothing', { verifyCommand: 'echo broken >&2; exit 4' })).task;
    const badDone = await h.waitForTask(bad.id, ['completed', 'failed']);
    expect(badDone.status).toBe('failed');
    expect(badDone.errorMessage).toContain('verification failed (exit 4)');
    expect(badDone.verifyOutput).toContain('broken');
  });

  it('cancels a running worker and its process tree', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'SLEEP 60000');
    await h.waitForTask(task.id, ['running']);
    const t0 = Date.now();
    await h.admin('POST', `/api/tasks/${task.id}/cancel`);
    expect((await h.waitForTask(task.id, ['cancelled'], 8000)).status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it('long-polls check_task_status until a task changes state', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'SLEEP 600');
    await h.waitForTask(task.id, ['running']);
    const t0 = Date.now();
    const res = (await h.manager('GET', `/api/tasks/status?ids=${task.id}&wait=15`)).body.tasks[0];
    expect(res.status).toBe('completed');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('warns when an agent cannot gate approvals but a gating policy was requested', async () => {
    const repo = newRepo();
    const { warnings } = await create(repo, 'codex', 'SAY hi', { approvalPolicy: 'ask_shell' });
    expect(warnings[0]).toContain('cannot gate approvals');
  });

  it('fails cleanly when the agent CLI is not installed', async () => {
    const repo = newRepo();
    const res = await h.admin('POST', '/api/tasks', { repoPath: repo, agent: 'gemini', title: 'g', prompt: 'x' });
    const failed = await h.waitForTask(res.body.task.id, ['failed']);
    expect(failed.errorMessage).toMatch(/not found on PATH/);
  });
});

describe('merge gate for the manager agent', () => {
  it('requires human approval for manager-initiated merges, then merges automatically on approval', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'WRITE m.txt managed');
    await h.waitForTask(task.id, ['completed']);

    const req = await h.manager('POST', `/api/tasks/${task.id}/merge`, { squash: true });
    expect(req.status).toBe(202);
    expect(req.body.status).toBe('pending_approval');
    expect(existsSync(join(repo, 'm.txt'))).toBe(false);
    expect((await h.admin('GET', `/api/tasks/${task.id}`)).body.task.status).toBe('completed');

    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals;
    expect(pending.find((a: any) => a.id === req.body.approvalId)).toMatchObject({ toolName: 'merge_worktree', taskId: task.id });
    expect((await h.manager('POST', `/api/approvals/${req.body.approvalId}/resolve`, { decision: 'approve' })).status).toBe(403);

    expect((await h.admin('POST', `/api/approvals/${req.body.approvalId}/resolve`, { decision: 'approve' })).status).toBe(200);
    await h.waitForTask(task.id, ['merged']);
    expect(readFileSync(join(repo, 'm.txt'), 'utf8')).toBe('managed\n');
  });

  it('a denied manager merge changes nothing; conflicts are reported on the task', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'WRITE a.txt WORKER');
    await h.waitForTask(task.id, ['completed']);
    const req = await h.manager('POST', `/api/tasks/${task.id}/merge`, {});
    await h.admin('POST', `/api/approvals/${req.body.approvalId}/resolve`, { decision: 'deny' });
    expect((await h.admin('GET', `/api/tasks/${task.id}`)).body.task.status).toBe('completed');

    // conflicting change lands on main; a human merge now reports the conflict
    sh(repo, 'sh', '-c', 'echo MAIN > a.txt && git commit -qam conflict');
    const res = await h.admin('POST', `/api/tasks/${task.id}/merge`, {});
    expect(res.body).toEqual({ status: 'conflict', conflictedFiles: ['a.txt'] });
    expect((await h.admin('GET', `/api/tasks/${task.id}`)).body.task.errorMessage).toContain('merge_conflict: a.txt');
  });

  it('refuses to merge tasks that are not completed', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'SLEEP 2000');
    await h.waitForTask(task.id, ['running']);
    expect((await h.admin('POST', `/api/tasks/${task.id}/merge`, {})).status).toBe(409);
    await h.waitForTask(task.id, ['completed']);
  });
});

describe('PTY worker approvals (prompt detection)', () => {
  it('surfaces a detected prompt in the approval queue and types the human decision into the terminal', async () => {
    const repo = newRepo();
    const events: string[] = [];
    h.daemon.bus.on('approval.requested', (a) => events.push(a.summary));

    const { task, warnings } = await create(repo, 'antigravity', 'SAY start;;ASK rm -rf build;;WRITE after.txt ok', { approvalPolicy: 'ask_shell' });
    expect(warnings).toEqual([]);
    const waiting = await h.waitForTask(task.id, ['waiting_approval']);
    expect(waiting.status).toBe('waiting_approval');

    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals.find((a: any) => a.taskId === task.id);
    expect(pending.summary).toBe('rm -rf build');
    expect(events).toContain('rm -rf build');

    await h.admin('POST', `/api/approvals/${pending.id}/resolve`, { decision: 'approve' });
    const done = await h.waitForTask(task.id, ['completed']);
    expect(done.status).toBe('completed');
    expect(h.daemon.tasks.getTerminalBuffer(task.id)).toContain('ANSWER:y');
    expect(readFileSync(join(task.worktreePath, 'after.txt'), 'utf8')).toBe('ok\n');
  });

  it('types "n" when the human denies', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'antigravity', 'ASK curl evil.sh', { approvalPolicy: 'ask_all' });
    await h.waitForTask(task.id, ['waiting_approval']);
    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals.find((a: any) => a.taskId === task.id);
    await h.admin('POST', `/api/approvals/${pending.id}/resolve`, { decision: 'deny' });
    await h.waitForTask(task.id, ['completed']);
    expect(h.daemon.tasks.getTerminalBuffer(task.id)).toContain('ANSWER:n');
  });

  it('streams throttled pty.data to subscribers and replays the buffer', async () => {
    const repo = newRepo();
    const chunks: string[] = [];
    h.daemon.bus.on('pty.data', (p) => chunks.push(p.chunk));
    const { task } = await create(repo, 'antigravity', 'SAY streaming-output');
    await h.waitForTask(task.id, ['completed']);
    await waitUntil(() => chunks.join('').includes('streaming-output'), 3000, 'pty.data');
    expect(h.daemon.tasks.getTerminalBuffer(task.id)).toContain('streaming-output');
  });
});

describe('Claude PreToolUse hook gating', () => {
  const readLog = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '');

  it('auto-allows in-worktree edits, asks for shell, and blocks until a human decides', async () => {
    const repo = newRepo();
    const { task, warnings } = await create(repo, 'claude', 'WRITE inside.txt fine;;BASH npm publish;;SAY finished', { approvalPolicy: 'ask_shell' });
    expect(warnings).toEqual([]);

    await h.waitForTask(task.id, ['waiting_approval']);
    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals.find((a: any) => a.taskId === task.id);
    expect(pending).toMatchObject({ toolName: 'Bash', summary: 'npm publish' });
    expect(readLog(task.worktreePath, 'bash-log.txt')).toBe(''); // still blocked inside the hook

    await h.admin('POST', `/api/approvals/${pending.id}/resolve`, { decision: 'deny' });
    await h.waitForTask(task.id, ['completed']);
    expect(readLog(task.worktreePath, 'bash-log.txt')).toBe('deny:npm publish\n');
    expect(readLog(task.worktreePath, 'write-log.txt')).toBe('allow:inside.txt\n');
    expect(readFileSync(join(task.worktreePath, 'inside.txt'), 'utf8')).toBe('fine\n');

    // injected hook settings never leak into the diff
    const diff = (await h.admin('GET', `/api/tasks/${task.id}/diff`)).body;
    expect(diff.files.map((f: any) => f.path)).not.toContain('.claude/settings.local.json');
  });

  it('records policy decisions: safe commands pass under auto_edit, writes outside the worktree need approval', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'claude', 'BASH git status;;WRITE /tmp/agg-outside.txt x', { approvalPolicy: 'auto_edit' });
    await h.waitForTask(task.id, ['waiting_approval']);
    expect(readLog(task.worktreePath, 'bash-log.txt')).toBe('allow:git status\n');

    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals.find((a: any) => a.taskId === task.id);
    expect(pending.toolName).toBe('Write');
    await h.admin('POST', `/api/approvals/${pending.id}/resolve`, { decision: 'deny' });
    await h.waitForTask(task.id, ['completed']);
    expect(existsSync('/tmp/agg-outside.txt')).toBe(false);

    const all = (await h.admin('GET', '/api/approvals')).body.approvals.filter((a: any) => a.taskId === task.id);
    expect(all.find((a: any) => a.summary === 'git status')).toMatchObject({ status: 'approved', resolvedBy: 'policy' });
  });

  it('remembers an approved command for the rest of the task', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'claude', 'BASH make deploy;;BASH make deploy', { approvalPolicy: 'ask_shell' });
    await h.waitForTask(task.id, ['waiting_approval']);
    const pending = (await h.admin('GET', '/api/approvals?status=pending')).body.approvals.find((a: any) => a.taskId === task.id);
    await h.admin('POST', `/api/approvals/${pending.id}/resolve`, { decision: 'approve', rememberForTask: true });
    await h.waitForTask(task.id, ['completed']);
    expect(readLog(task.worktreePath, 'bash-log.txt')).toBe('allow:make deploy\nallow:make deploy\n');
  });

  it('captures the session id and resumes it natively on send_feedback', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'claude', 'WRITE one.txt 1', { approvalPolicy: 'auto_edit' });
    const first = await h.waitForTask(task.id, ['completed']);
    expect(first.sessionId).toMatch(/^sess-/);

    const fb = await h.manager('POST', `/api/tasks/${task.id}/feedback`, { message: 'WRITE two.txt 2' });
    expect(fb.status).toBe(200);
    await waitUntil(async () => (await h.admin('GET', `/api/tasks/${task.id}`)).body.task.status === 'running' || existsSync(join(task.worktreePath, 'two.txt')), 5000);
    await h.waitForTask(task.id, ['completed']);
    const resumed = readFileSync(join(task.worktreePath, 'resumed.txt'), 'utf8');
    expect(resumed.split('\n')[0]).toBe(first.sessionId);
    expect(readFileSync(join(task.worktreePath, 'two.txt'), 'utf8')).toBe('2\n');
    const diff = (await h.admin('GET', `/api/tasks/${task.id}/diff`)).body;
    expect(diff.files.map((f: any) => f.path)).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
  });

  it('rejects feedback while a headless worker is still running', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'SLEEP 800');
    await h.waitForTask(task.id, ['running']);
    expect((await h.admin('POST', `/api/tasks/${task.id}/feedback`, { message: 'hi' })).status).toBe(409);
    await h.waitForTask(task.id, ['completed']);
  });

  it('replays the original task for agents without native resume', async () => {
    const repo = newRepo();
    const { task } = await create(repo, 'codex', 'WRITE r1.txt 1');
    await h.waitForTask(task.id, ['completed']);
    // mock-agent ignores everything it cannot parse, so replayed prompts are harmless; we assert that a new run happens
    const before = (await h.admin('GET', `/api/tasks/${task.id}/logs`)).body.logs.filter((l: any) => l.stream === 'system').length;
    await h.admin('POST', `/api/tasks/${task.id}/feedback`, { message: 'WRITE r2.txt 2' });
    await waitUntil(async () => (await h.admin('GET', `/api/tasks/${task.id}/logs`)).body.logs.filter((l: any) => l.stream === 'system').length > before, 5000);
    await h.waitForTask(task.id, ['completed']);
  });
});

describe('rate limits', () => {
  it('detects a 429 from a worker, stops it, records usage and notifies', async () => {
    const repo = newRepo();
    const notices: any[] = [];
    h.daemon.bus.on('agent.rateLimited', (n) => notices.push(n));
    const { task } = await create(repo, 'codex', 'SAY working;;RATELIMIT');
    // codex mock above uses a non-PTY custom adapter with the default 429 matcher
    const limited = await h.waitForTask(task.id, ['rate_limited'], 10_000);
    expect(limited.status).toBe('rate_limited');

    const n = await waitUntil(() => notices.find((x) => x.agent === 'codex'), 3000, 'agent.rateLimited');
    expect(n.resetAt).toBeGreaterThan(Date.now());
    expect(n.fallbackSuggested).not.toBe('codex');

    const health = (await h.admin('GET', '/api/agents/health')).body.agents;
    expect(health.find((a: any) => a.id === 'codex').rateLimitedUntil).toBeGreaterThan(Date.now());
  });
});

describe('scheduling', () => {
  it('queues work beyond maxConcurrent and starts it when a slot frees up', async () => {
    const limited = await startHarness({ maxConcurrent: 1 });
    try {
      const repo = newRepo();
      const mk = async (prompt: string) =>
        (await limited.admin('POST', '/api/tasks', { repoPath: repo, agent: 'codex', title: 't', prompt })).body.task;
      const first = await mk('SLEEP 800');
      const second = await mk('WRITE q.txt q');
      expect((await limited.admin('GET', `/api/tasks/${second.id}`)).body.task.status).toBe('queued');
      await limited.waitForTask(first.id, ['completed']);
      expect((await limited.waitForTask(second.id, ['completed'])).status).toBe('completed');
    } finally {
      await limited.stop();
    }
  });
});

describe('JSON-RPC over WebSocket', () => {
  const open = (protocols: string[]) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(h.daemon.url.replace('http', 'ws') + '/ws', protocols);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('ws error'));
    });
  const rpc = (ws: WebSocket, method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = Math.random();
      const onMsg = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === id) {
          ws.removeEventListener('message', onMsg);
          resolve(m);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  it('requires the admin token (subprotocol), not the manager token or none', async () => {
    await expect(open(['aggregator.v1'])).rejects.toThrow();
    await expect(open(['aggregator.v1', `bearer.${h.config.managerToken}`])).rejects.toThrow();
  });

  it('serves RPC methods, pushes notifications and streams subscribed terminals', async () => {
    const ws = await open(['aggregator.v1', `bearer.${h.config.token}`]);
    const pushes: any[] = [];
    ws.addEventListener('message', (ev) => pushes.push(JSON.parse(String(ev.data))));
    try {
      const health = await rpc(ws, 'agent.health');
      expect(health.result.agents.map((a: any) => a.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'antigravity']));
      expect((await rpc(ws, 'nope')).error.code).toBe(-32601);
      expect((await rpc(ws, 'task.cancel', {})).error.code).toBe(-32602);

      const repo = newRepo();
      const created = await rpc(ws, 'task.create', { repoPath: repo, agent: 'antigravity', title: 'ws', prompt: 'SAY via-ws;;ASK echo hi', approvalPolicy: 'ask_all' });
      const taskId = created.result.task.id;
      const sub = await rpc(ws, 'task.subscribe', { taskId });
      expect(sub.result).toHaveProperty('buffer');

      const approval = await waitUntil(() => pushes.find((p) => p.method === 'approval.requested'), 8000, 'approval.requested push');
      expect(approval.params).toMatchObject({ taskId, toolName: 'shell', summary: 'echo hi' });
      await waitUntil(() => pushes.some((p) => p.method === 'pty.data' && p.params.chunk.includes('via-ws')), 5000, 'pty.data push');

      const resolved = await rpc(ws, 'approval.resolve', { approvalId: approval.params.approvalId, decision: 'approve' });
      expect(resolved.result.approval.status).toBe('approved');
      await waitUntil(() => pushes.some((p) => p.method === 'task.updated' && p.params.taskId === taskId && p.params.status === 'completed'), 8000, 'completed push');

      const merged = await rpc(ws, 'git.merge', { taskId });
      expect(merged.result.status).toBe('merged');
    } finally {
      ws.close();
    }
  });
});

describe('crash recovery', () => {
  it('marks tasks that were active when the daemon died as failed and expires stale approvals', async () => {
    const first = await startHarness();
    const repo = newRepo();
    const mk = await first.admin('POST', '/api/tasks', { repoPath: repo, agent: 'codex', title: 'orphan', prompt: 'SLEEP 1000' });
    const id = mk.body.task.id;
    await first.waitForTask(id, ['running']);
    // simulate a hard crash: flip the row back to "running" after a clean shutdown wrote its final state
    const { home, config } = first;
    await first.daemon.close();
    const { openDb } = await import('../src/db/index.js');
    const db = openDb(config.dbPath);
    db.prepare("UPDATE tasks SET status = 'running', error_message = NULL WHERE id = ?").run(id);
    db.close();

    const second = await startDaemon(loadConfig({}, { home, port: 0 }));
    try {
      const t = second.repo.getTask(id)!;
      expect(t.status).toBe('failed');
      expect(t.errorMessage).toContain('daemon restarted');
      expect(existsSync(t.worktreePath)).toBe(true); // worktree preserved so the task can be retried
    } finally {
      await second.close();
      cleanup(home);
    }
  });
});

describe('manager chat', () => {
  const chatRepo = newRepo();
  const waitIdle = (chatId: string) =>
    waitUntil(async () => !(await h.admin('GET', `/api/chats/${chatId}/messages`)).body.busy, 15_000, 'manager idle');
  const transcript = async (chatId: string) => (await h.admin('GET', `/api/chats/${chatId}/messages`)).body.messages as Array<{ role: string; content: string }>;

  it('creates a chat, runs the manager with only MCP + read tools, persists and broadcasts the transcript', async () => {
    const pushes: string[] = [];
    h.daemon.bus.on('chat.message', (m) => pushes.push(`${m.role}:${m.content}`));

    expect((await h.admin('POST', '/api/chats', { repoPath: '/tmp' })).status).toBe(400);
    const created = await h.admin('POST', '/api/chats', { repoPath: chatRepo });
    expect(created.status).toBe(201);
    const chatId = created.body.chat.id;

    expect((await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'SAY hello from the manager' })).status).toBe(202);
    await waitIdle(chatId);
    expect(await transcript(chatId)).toEqual([
      expect.objectContaining({ role: 'user', content: 'SAY hello from the manager' }),
      expect.objectContaining({ role: 'assistant', content: 'hello from the manager' }),
    ]);
    expect(pushes).toEqual(['user:SAY hello from the manager', 'assistant:hello from the manager']);

    const argv = JSON.parse(readFileSync(join(chatRepo, 'chat-argv.json'), 'utf8'));
    expect(argv.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--output-format', 'stream-json']));
    expect(argv.args[argv.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(argv.args[argv.args.indexOf('--allowedTools') + 1]).toBe('mcp__aggregator,Read,Glob,Grep');
    expect(argv.args[argv.args.indexOf('--append-system-prompt') + 1]).toContain(chatRepo);
    const server = argv.mcpConfig.mcpServers.aggregator;
    expect(server.env).toEqual({ AGGREGATOR_URL: h.daemon.url, AGGREGATOR_MANAGER_TOKEN: h.config.managerToken });
    expect(statSync(join(h.home, 'manager-mcp.json')).mode & 0o777).toBe(0o600);
  });

  it('resumes the same session on the next message and rejects overlapping messages', async () => {
    const chatId = (await h.admin('POST', '/api/chats', { repoPath: chatRepo })).body.chat.id;
    await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'SAY one' });
    await waitIdle(chatId);
    const sessionId = (await h.admin('GET', '/api/chats')).body.chats.find((c: any) => c.id === chatId).sessionId;
    expect(sessionId).toMatch(/^sess-/);

    await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'SAY two' });
    await waitIdle(chatId);
    expect(readFileSync(join(chatRepo, 'resumed.txt'), 'utf8').split('\n')[0]).toBe(sessionId);
    expect((await transcript(chatId)).filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['one', 'two']);

    // busy: a second message sent while the first is running is refused
    const first = await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'SAY three' });
    const second = await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'SAY four' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    await waitIdle(chatId);
  });

  it('only the human operator can talk to the manager', async () => {
    const chatId = (await h.admin('POST', '/api/chats', { repoPath: chatRepo })).body.chat.id;
    expect((await h.manager('POST', `/api/chats/${chatId}/messages`, { message: 'hi' })).status).toBe(403);
    expect((await h.manager('POST', '/api/chats', { repoPath: chatRepo })).status).toBe(403);
    expect((await h.admin('POST', '/api/chats/cht_missing/messages', { message: 'hi' })).status).toBe(404);
  });

  it('reports a failing manager process in the transcript', async () => {
    const chatId = (await h.admin('POST', '/api/chats', { repoPath: chatRepo })).body.chat.id;
    await h.admin('POST', `/api/chats/${chatId}/messages`, { message: 'EXIT 5' });
    await waitIdle(chatId);
    const last = (await transcript(chatId)).at(-1)!;
    expect(last).toMatchObject({ role: 'system' });
    expect(last.content).toContain('exited with code 5');
  });
});

describe('task.created push', () => {
  it('broadcasts task.created for tasks created over REST', async () => {
    const created: string[] = [];
    h.daemon.bus.on('task.created', (t) => created.push(t.id));
    const { task } = await create(newRepo(), 'codex', 'SAY hi');
    expect(created).toContain(task.id);
    await h.waitForTask(task.id, ['completed']);
  });
});
