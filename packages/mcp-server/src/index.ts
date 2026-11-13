import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonClient, loadClientConfig } from './client.js';
import { createServer } from './server.js';

/** Config snippet for Claude Code (`claude mcp add-json` / .mcp.json / claude_desktop_config.json). */
export function claudeMcpConfig(entry: string, env: Record<string, string> = {}) {
  return { mcpServers: { aggregator: { command: process.execPath, args: [entry], env } } };
}

if (process.argv.includes('--print-config')) {
  const entry = fileURLToPath(import.meta.url);
  console.log(JSON.stringify(claudeMcpConfig(entry), null, 2));
  console.error(
    '\nSave as .mcp.json in your repo (or pass with `claude --mcp-config`). The manager token is read from ~/.aggregator/manager.key;\n' +
      'set AGGREGATOR_URL / AGGREGATOR_MANAGER_TOKEN in "env" for a non-default daemon.',
  );
} else {
  const client = new DaemonClient(loadClientConfig());
  await createServer(client).connect(new StdioServerTransport());
}
