import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import { startDaemon } from './daemon.js';

const config = loadConfig();
const daemon = await startDaemon(config).catch((err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${config.port} is already in use by another process.\n` +
        `  See what it is:   lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n` +
        `  Or pick another:  AGGREGATOR_PORT=${config.port + 1} npm start\n`,
    );
    process.exit(1);
  }
  throw err;
});

// The token travels in the URL fragment, which browsers never send to servers or put in logs.
const link = (base: string) => `${base}/#token=${config.token}`;
console.log(`
Coding Agent Aggregator
  Open the control plane:  ${link(daemon.url)}
  Admin token    ${config.home}/secret.key       (web/mobile UI)
  Manager token  ${config.home}/manager.key      (MCP server for the manager agent)
  Agents config  ${config.agentsConfigPath}
  Database       ${config.dbPath}
`);

if (config.publicUrl) {
  console.log(`Scan to pair a phone (${config.publicUrl}):`);
  qrcode.generate(link(config.publicUrl), { small: true });
} else {
  console.log('Phone access: run `tailscale serve --bg ' + config.port + '`, then restart with AGGREGATOR_PUBLIC_URL=https://<machine>.<tailnet>.ts.net to get a pairing QR code.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void daemon.close().finally(() => process.exit(0));
  });
}
