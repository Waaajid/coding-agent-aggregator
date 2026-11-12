import type { FastifyInstance } from 'fastify';
import { AdapterRegistry } from './adapters/registry.js';
import type { AgentAdapter } from './adapters/types.js';
import { ApprovalService } from './approvals.js';
import type { DaemonConfig } from './config.js';
import { openDb } from './db/index.js';
import { Repo } from './db/repo.js';
import { Bus } from './events.js';
import { ChatRepo } from './db/chats.js';
import { WorktreeManager } from './git/WorktreeManager.js';
import { ManagerService, type ManagerOptions } from './manager.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskRunner } from './runtime/TaskRunner.js';
import { TaskService } from './runtime/TaskService.js';
import { buildApp } from './server/app.js';

export interface Daemon {
  app: FastifyInstance;
  tasks: TaskService;
  repo: Repo;
  bus: Bus;
  url: string;
  close(): Promise<void>;
}

const DEFAULT_WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export async function startDaemon(
  config: DaemonConfig,
  opts: { registry?: AdapterRegistry; manager?: ManagerOptions; webRoot?: string } = {},
): Promise<Daemon> {
  const db = openDb(config.dbPath);
  const repo = new Repo(db);
  const bus = new Bus();
  const registry = opts.registry ?? AdapterRegistry.fromFile(config.agentsConfigPath);
  const runner = new TaskRunner(repo, bus);
  const approvals = new ApprovalService(repo, bus, config.approvalTimeoutMs);
  let url = `http://${config.host}:${config.port}`;
  const wm = new WorktreeManager();
  const tasks = new TaskService({
    repo,
    wm,
    registry,
    runner,
    approvals,
    bus,
    config,
    daemonUrl: () => url,
  });
  await tasks.recover();

  const manager = new ManagerService(new ChatRepo(db), bus, wm, config, () => url, opts.manager);
  const webRoot = opts.webRoot ?? DEFAULT_WEB_ROOT;
  const app = await buildApp({ config, repo, bus, tasks, approvals, registry, manager, webRoot: existsSync(webRoot) ? webRoot : undefined });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  url = `http://${config.host}:${port}`;
  config.allowedOrigins.add(`http://127.0.0.1:${port}`).add(`http://localhost:${port}`);

  return {
    app,
    tasks,
    repo,
    bus,
    url,
    async close() {
      await manager.shutdown();
      await tasks.shutdown();
      await app.close();
      db.close();
    },
  };
}

export type { AgentAdapter };
