// Mock `claude` CLI for tests: emits stream-json and runs the real PreToolUse hook configured in
// .claude/settings.local.json before each tool call, exactly like Claude Code does.
// Usage: node mock-claude.mjs -p "<STEP>;;<STEP>" --output-format stream-json --verbose [--resume <id>]
// Steps: BASH <command> | WRITE <file> <content> | SAY <text> | EXIT <code>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const resumeIdx = args.indexOf('--resume');
const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const sessionId = resumed ?? `sess-${Math.random().toString(36).slice(2, 10)}`;

// Manager-chat runs: record what the daemon passed so tests can assert on it.
if (process.env.AGGREGATOR_CHAT_ID) {
  const cfgPath = args[args.indexOf('--mcp-config') + 1];
  writeFileSync('chat-argv.json', JSON.stringify({ args, mcpConfig: cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null }));
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sessionId });
if (resumed) writeFileSync('resumed.txt', `${resumed}\n${prompt}\n`);

function runHook(toolName, toolInput) {
  const settings = JSON.parse(readFileSync('.claude/settings.local.json', 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const res = spawnSync('sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(res.stdout).hookSpecificOutput.permissionDecision;
}

for (const step of prompt.split(';;').map((s) => s.trim()).filter(Boolean)) {
  const [cmd, ...rest] = step.split(' ');
  if (cmd === 'BASH') {
    const command = rest.join(' ');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
    const decision = runHook('Bash', { command });
    writeFileSync('bash-log.txt', `${decision}:${command}\n`, { flag: 'a' });
  } else if (cmd === 'WRITE') {
    const [file, ...content] = rest;
    const decision = runHook('Write', { file_path: file.startsWith('/') ? file : `${process.cwd()}/${file}`, content: content.join(' ') });
    if (decision === 'allow') writeFileSync(file, content.join(' ') + '\n');
    writeFileSync('write-log.txt', `${decision}:${file}\n`, { flag: 'a' });
  } else if (cmd === 'SAY') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: rest.join(' ') }] } });
  } else if (cmd === 'EXIT') {
    process.exit(Number(rest[0]));
  }
}
out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'done' });
