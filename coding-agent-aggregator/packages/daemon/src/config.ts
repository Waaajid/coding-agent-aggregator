import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonConfig {
  home: string;
  host: string;
  port: number;
  dbPath: string;
  /** Full-privilege credential for the human-facing UI (`secret.key`). */
  token: string;
  /** Reduced-privilege credential for the manager agent's MCP server (`manager.key`): cannot resolve approvals. */
  managerToken: string;
  agentsConfigPath: string;
  /** Hostnames accepted in the Host header (DNS-rebinding defence). Extend for Tailscale/LAN access. */
  allowedHostnames: Set<string>;
  /** Exact origins accepted when a browser sends an Origin header. */
  allowedOrigins: Set<string>;
  maxConcurrent: number;
  approvalTimeoutMs: number;
  /** Externally reachable URL (e.g. `tailscale serve`), used for the pairing link/QR code. Its host/origin are auto-allowed. */
  publicUrl: string | null;
  /** When true, a merge requested by the manager agent needs a human to approve it first. */
  requireHumanMerge: boolean;
}

export function loadOrCreateToken(home: string, file = 'secret.key'): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, file);
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function csv(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const home = overrides.home ?? env.AGGREGATOR_HOME ?? join(homedir(), '.aggregator');
  const port = overrides.port ?? Number(env.AGGREGATOR_PORT ?? 4173);
  const extraHosts = csv(env.AGGREGATOR_EXTRA_HOSTS);
  const publicUrl = (env.AGGREGATOR_PUBLIC_URL ?? '').replace(/\/$/, '') || null;
  const allowedOrigins = csv(env.AGGREGATOR_ALLOWED_ORIGINS);
  if (publicUrl) {
    const u = new URL(publicUrl);
    extraHosts.push(u.hostname);
    allowedOrigins.push(u.origin);
  }
  return {
    home,
    host: '127.0.0.1',
    port,
    dbPath: join(home, 'aggregator.db'),
    token: loadOrCreateToken(home),
    managerToken: loadOrCreateToken(home, 'manager.key'),
    agentsConfigPath: join(home, 'agents.json'),
    allowedHostnames: new Set(['127.0.0.1', 'localhost', '[::1]', ...extraHosts]),
    allowedOrigins: new Set(allowedOrigins),
    publicUrl,
    maxConcurrent: Number(env.AGGREGATOR_MAX_CONCURRENT ?? 4),
    approvalTimeoutMs: Number(env.AGGREGATOR_APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000),
    requireHumanMerge: env.AGGREGATOR_REQUIRE_HUMAN_MERGE !== '0',
    ...overrides,
  };
}
