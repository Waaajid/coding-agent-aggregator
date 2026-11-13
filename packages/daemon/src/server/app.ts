import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  CreateTaskInputSchema,
  MergeInputSchema,
  ResolveApprovalInputSchema,
  TaskStatusSchema,
  type ApprovalActor,
} from '@aggregator/shared';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { ApprovalService } from '../approvals.js';
import type { DaemonConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Bus } from '../events.js';
import type { ManagerService } from '../manager.js';
import { ServiceError, type TaskService } from '../runtime/TaskService.js';
import { registerWebSocket } from './ws.js';

export type Role = 'admin' | 'manager';

declare module 'fastify' {
  interface FastifyRequest {
    role?: Role;
  }
}

export interface AppDeps {
  config: DaemonConfig;
  repo: Repo;
  bus: Bus;
  tasks: TaskService;
  approvals: ApprovalService;
  registry: AdapterRegistry;
  manager: ManagerService;
  /** Directory with the built web UI; served unauthenticated (it contains no secrets). */
  webRoot?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  // Browsers can't set headers on WebSocket upgrades, so accept the token as a subprotocol (never in the URL).
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  return protocols.find((p) => p.startsWith('bearer.'))?.slice('bearer.'.length);
}

function hostname(hostHeader: string | undefined): string {
  const h = (hostHeader ?? '').trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
}

export async function agentHealth(deps: Pick<AppDeps, 'registry' | 'repo'>) {
  return Promise.all(
    deps.registry.list().map(async (a) => ({
      id: a.id,
      displayName: a.displayName,
      ...(await a.detectInstalled()),
      supportsApprovalGating: a.supportsApprovalGating,
      supportsNativeResume: a.supportsNativeResume,
      rateLimitedUntil: deps.repo.activeRateLimit(a.id)?.resetAt ?? null,
    })),
  );
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, tasks, approvals, repo, manager } = deps;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      handleProtocols: (protocols: Set<string>) => (protocols.has('aggregator.v1') ? 'aggregator.v1' : false),
    },
  });

  // ---- request gate: Host + Origin checks (DNS rebinding / drive-by CSRF), then per-area auth -----------------
  app.addHook('onRequest', async (req, reply) => {
    if (!config.allowedHostnames.has(hostname(req.headers.host))) {
      return reply.code(403).send({ error: 'host not allowed' });
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }

    const path = req.url.split('?')[0]!;
    if (path === '/healthz' || path.startsWith('/internal/')) return; // internal routes use per-task hook tokens
    const isApi = path.startsWith('/api/') || path === '/ws';
    if (!isApi && (req.method === 'GET' || req.method === 'HEAD')) return; // static web UI assets
    const token = bearerToken(req);
    if (token && safeEqual(token, config.token)) req.role = 'admin';
    else if (token && safeEqual(token, config.managerToken)) req.role = 'manager';
    else return reply.code(401).send({ error: 'missing or invalid token' });
    if (path === '/ws' && req.role !== 'admin') return reply.code(403).send({ error: 'websocket requires the admin token' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid input', issues: err.issues });
    if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'internal error' : err.message });
  });

  const idParams = z.object({ id: z.string().min(1) });

  app.get('/healthz', async () => ({ ok: true }));

  // ---- tasks -----------------------------------------------------------------------------------------------
  app.post('/api/tasks', async (req, reply) => {
    const input = CreateTaskInputSchema.parse(req.body);
    const { task, warnings } = await tasks.createTask(input);
    return reply.code(201).send({ task, warnings });
  });

  app.get('/api/tasks', async (req) => {
    const q = z.object({ status: z.string().optional(), repoId: z.string().optional() }).parse(req.query);
    const status = q.status ? z.array(TaskStatusSchema).parse(q.status.split(',')) : undefined;
    return { tasks: tasks.listTasks({ status, repoId: q.repoId }) };
  });

  // Registered before /api/tasks/:id; find-my-way gives static segments priority.
  app.get('/api/tasks/status', async (req) => {
    const q = z.object({ ids: z.string().min(1), wait: z.coerce.number().min(0).max(60).default(0) }).parse(req.query);
    return { tasks: await tasks.getStatuses(q.ids.split(','), q.wait) };
  });

  app.get('/api/tasks/:id', async (req) => ({ task: tasks.getTask(idParams.parse(req.params).id) }));
  app.post('/api/tasks/:id/cancel', async (req) => ({ task: tasks.cancel(idParams.parse(req.params).id) }));
  app.post('/api/tasks/:id/retry', async (req) => ({ task: tasks.retry(idParams.parse(req.params).id) }));

  app.post('/api/tasks/:id/input', async (req) => {
    const { data } = z.object({ data: z.string() }).parse(req.body);
    tasks.sendInput(idParams.parse(req.params).id, data);
    return { ok: true };
  });

  app.post('/api/tasks/:id/feedback', async (req) => {
    const { message } = z.object({ message: z.string().min(1) }).parse(req.body);
    return { task: tasks.sendFeedback(idParams.parse(req.params).id, message) };
  });

  app.get('/api/tasks/:id/diff', async (req) => {
    const q = z.object({ file: z.string().optional(), maxLines: z.coerce.number().int().min(1).max(50_000).default(500) }).parse(req.query);
    return tasks.getDiff(idParams.parse(req.params).id, q.file, q.maxLines);
  });

  app.get('/api/tasks/:id/logs', async (req) => {
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(req.query);
    return { logs: tasks.getLogs(idParams.parse(req.params).id, q.after, q.limit) };
  });

  app.post('/api/tasks/:id/merge', async (req, reply) => {
    const input = MergeInputSchema.parse(req.body ?? {});
    // The caller's credential decides the actor; clients cannot claim to be a human.
    let actor: ApprovalActor = 'manager_agent';
    if (req.role === 'admin') actor = req.headers['x-aggregator-client'] === 'mobile' ? 'mobile_ui' : 'web_ui';
    const outcome = await tasks.merge(idParams.parse(req.params).id, input, actor);
    return reply.code(outcome.status === 'pending_approval' ? 202 : 200).send(outcome);
  });

  // ---- approvals -------------------------------------------------------------------------------------------
  app.get('/api/approvals', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() }).parse(req.query);
    return { approvals: repo.listApprovals(q.status) };
  });

  app.post('/api/approvals/:id/resolve', async (req, reply) => {
    if (req.role !== 'admin') return reply.code(403).send({ error: 'only the human operator can resolve approvals' });
    const input = ResolveApprovalInputSchema.parse(req.body);
    const { id } = idParams.parse(req.params);
    if (!repo.getApproval(id)) throw new ServiceError(404, `approval not found: ${id}`);
    const by: ApprovalActor = req.headers['x-aggregator-client'] === 'mobile' ? 'mobile_ui' : 'web_ui';
    return { approval: approvals.resolve(id, input.decision, by, input.rememberForTask) };
  });

  app.get('/api/agents/health', async () => ({ agents: await agentHealth(deps) }));

  // ---- manager chat ----------------------------------------------------------------------------------------
  const requireAdmin = (req: FastifyRequest) => {
    if (req.role !== 'admin') throw new ServiceError(403, 'only the human operator can use the manager chat');
  };

  app.get('/api/chats', async () => ({ chats: manager.listChats() }));

  app.post('/api/chats', async (req, reply) => {
    requireAdmin(req);
    const { repoPath } = z.object({ repoPath: z.string().min(1) }).parse(req.body);
    return reply.code(201).send({ chat: await manager.createChat(repoPath) });
  });

  app.get('/api/chats/:id/messages', async (req) => {
    const q = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const { id } = idParams.parse(req.params);
    return { messages: manager.messages(id, q.after), busy: manager.isBusy(id) };
  });

  app.post('/api/chats/:id/messages', async (req, reply) => {
    requireAdmin(req);
    const { message } = z.object({ message: z.string().min(1).max(20_000) }).parse(req.body);
    return reply.code(202).send({ message: await manager.send(idParams.parse(req.params).id, message) });
  });

  app.post('/api/chats/:id/cancel', async (req) => {
    requireAdmin(req);
    return { cancelled: manager.cancel(idParams.parse(req.params).id) };
  });

  // ---- internal: Claude PreToolUse hook (per-task token) ----------------------------------------------------
  const hookAuth = (req: FastifyRequest, taskId: string): boolean => {
    const token = bearerToken(req);
    return Boolean(token) && tasks.verifyHookToken(taskId, token!);
  };

  app.post('/internal/approvals', async (req, reply) => {
    const body = z
      .object({ taskId: z.string(), toolName: z.string(), toolInput: z.record(z.unknown()).default({}) })
      .parse(req.body);
    if (!hookAuth(req, body.taskId)) return reply.code(401).send({ error: 'invalid hook token' });
    const created = tasks.createToolApproval(body.taskId, body.toolName, body.toolInput);
    return approvals.wait(created.id, 25_000);
  });

  app.get('/internal/approvals/:id', async (req, reply) => {
    const q = z.object({ taskId: z.string(), wait: z.coerce.number().min(0).max(60).default(25) }).parse(req.query);
    const { id } = idParams.parse(req.params);
    if (!hookAuth(req, q.taskId)) return reply.code(401).send({ error: 'invalid hook token' });
    const approval = repo.getApproval(id);
    if (!approval || approval.taskId !== q.taskId) return reply.code(404).send({ error: 'approval not found' });
    return approvals.wait(id, q.wait * 1000);
  });

  if (deps.webRoot && existsSync(deps.webRoot)) {
    await app.register(fastifyStatic, {
      root: deps.webRoot,
      // index.html must always be revalidated; Vite's hashed assets can be cached forever.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.header('cache-control', filePath.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const isApi = req.url.startsWith('/api/') || req.url.startsWith('/internal/');
      return reply.code(404).send(isApi || req.method !== 'GET' ? { error: 'not found' } : 'Not found');
    });
  }

  registerWebSocket(app, deps);
  return app;
}
