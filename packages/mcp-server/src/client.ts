import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClientConfig {
  url: string;
  token: string;
}

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const url = (env.AGGREGATOR_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
  let token = env.AGGREGATOR_MANAGER_TOKEN?.trim();
  if (!token) {
    const file = env.AGGREGATOR_MANAGER_TOKEN_FILE ?? join(env.AGGREGATOR_HOME ?? join(homedir(), '.aggregator'), 'manager.key');
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`Cannot read the manager token (${file}). Start the daemon once (npm run daemon) or set AGGREGATOR_MANAGER_TOKEN.`);
    }
  }
  return { url, token };
}

export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal client for the daemon REST API using the manager credential. */
export class DaemonClient {
  constructor(private readonly cfg: ClientConfig) {}

  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.url + path, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new DaemonError(0, `Cannot reach the aggregator daemon at ${this.cfg.url} (${(err as Error).message}). Is it running? (npm run daemon)`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new DaemonError(res.status, data?.error ?? `daemon responded ${res.status}`);
    return data as T;
  }
}
