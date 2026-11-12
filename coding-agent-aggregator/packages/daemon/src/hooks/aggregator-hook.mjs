#!/usr/bin/env node
// Claude Code PreToolUse hook. Asks the aggregator daemon whether a tool call may run and blocks until a human
// (or policy) decides. Fails closed: if the daemon cannot be reached the tool call is denied.
//
// Env (set by the daemon for each worker): AGGREGATOR_URL, AGGREGATOR_TASK_ID, AGGREGATOR_HOOK_TOKEN

const url = process.env.AGGREGATOR_URL;
const taskId = process.env.AGGREGATOR_TASK_ID;
const token = process.env.AGGREGATOR_HOOK_TOKEN;
const POLL_SECONDS = 25;

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function call(path, init) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`daemon responded ${res.status}`);
  return res.json();
}

async function main() {
  if (!url || !taskId || !token) return respond('deny', 'aggregator hook is not configured for this task');

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return respond('deny', 'aggregator hook could not parse the tool call');
  }

  try {
    let approval = await call('/internal/approvals', {
      method: 'POST',
      body: JSON.stringify({ taskId, toolName: payload.tool_name, toolInput: payload.tool_input ?? {} }),
    });
    while (approval.status === 'pending') {
      approval = await call(`/internal/approvals/${approval.id}?wait=${POLL_SECONDS}&taskId=${taskId}`, { method: 'GET' });
    }
    if (approval.status === 'approved') return respond('allow', `approved by ${approval.resolvedBy ?? 'aggregator'}`);
    return respond('deny', `${approval.status} by ${approval.resolvedBy ?? 'aggregator'}`);
  } catch (err) {
    return respond('deny', `aggregator unreachable: ${err.message}`);
  }
}

main();
