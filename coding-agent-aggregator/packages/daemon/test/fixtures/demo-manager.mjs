// Demo stand-in for the manager's Claude session: on each message it delegates two tasks through the daemon API
// (the same calls the MCP tools make) and narrates, so the chat UI can be explored without a model.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const url = process.env.AGGREGATOR_URL;
const token = process.env.AGGREGATOR_MANAGER_TOKEN;
const sessionId = `demo-${Date.now().toString(36)}`;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = (name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__aggregator__${name}`, input }] } });

async function api(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

out({ type: 'system', subtype: 'init', session_id: sessionId });
await sleep(400);
if (/status|installed|healthy/i.test(prompt)) {
  tool('agent_health', {});
  const { agents } = await api('GET', '/api/agents/health');
  await sleep(300);
  say(`Agents: ${agents.map((a) => `${a.id} (${a.installed ? 'ready' : 'not installed'})`).join(', ')}.`);
} else {
  say('Plan: two independent sub-tasks — I will delegate them in parallel, each in its own worktree.');
  await sleep(500);
  const jobs = [
    { agent: 'codex', title: 'demo-api', prompt: 'SAY drafting the API;;SLEEP 1500;;WRITE api.txt endpoints;;SLEEP 1500', verifyCommand: 'test -f api.txt' },
    { agent: 'antigravity', title: 'demo-ui', prompt: 'SAY building the UI;;SLEEP 1200;;ASK npm run lint --fix ;;WRITE ui.txt components;;SLEEP 800' },
  ];
  const ids = [];
  for (const job of jobs) {
    const input = { repo_path: process.cwd(), ...job };
    tool('delegate_task', input);
    const { task } = await api('POST', '/api/tasks', { repoPath: process.cwd(), approvalPolicy: 'ask_shell', ...job });
    ids.push(task.id);
    await sleep(300);
  }
  tool('check_task_status', { task_ids: ids, wait_seconds: 15 });
  await sleep(400);
  say(`Delegated ${ids.length} tasks (${ids.join(', ')}). Watch them on the Overview; I will ask you before merging anything.`);
}
out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'done' });
