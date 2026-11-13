import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  CreateTaskInputSchema,
  MergeInputSchema,
  RpcErrors,
  type JsonRpcRequest,
} from '@aggregator/shared';
import { ServiceError } from '../runtime/TaskService.js';
import { agentHealth, type AppDeps } from './app.js';

const taskIdParams = z.object({ taskId: z.string().min(1) });

/** JSON-RPC 2.0 over WebSocket for the Web/Mobile control plane (admin token only). */
export function registerWebSocket(app: FastifyInstance, deps: AppDeps): void {
  const { tasks, approvals, bus, repo } = deps;
  const sockets = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Set<string>>();

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (method: string, params: unknown) => {
    for (const ws of sockets) send(ws, { jsonrpc: '2.0', method, params });
  };

  bus.on('task.created', (t) => broadcast('task.created', { task: t }));
  bus.on('task.updated', (p) => broadcast('task.updated', p));
  bus.on('chat.message', (m) => broadcast('chat.message', { message: m }));
  bus.on('chat.status', (p) => broadcast('chat.status', p));
  bus.on('approval.requested', (a) => broadcast('approval.requested', { approvalId: a.id, ...a }));
  bus.on('approval.resolved', (a) => broadcast('approval.resolved', { approvalId: a.id, taskId: a.taskId, status: a.status }));
  bus.on('agent.rateLimited', (p) => broadcast('agent.rateLimited', p));
  bus.on('pty.data', (p) => {
    for (const ws of sockets) if (subscriptions.get(ws)?.has(p.taskId)) send(ws, { jsonrpc: '2.0', method: 'pty.data', params: p });
  });

  const methods: Record<string, (ws: WebSocket, params: unknown) => unknown | Promise<unknown>> = {
    'task.create': async (_ws, p) => tasks.createTask(CreateTaskInputSchema.parse(p)),
    'task.list': () => ({ tasks: tasks.listTasks() }),
    'task.cancel': (_ws, p) => ({ task: tasks.cancel(taskIdParams.parse(p).taskId) }),
    'task.retry': (_ws, p) => ({ task: tasks.retry(taskIdParams.parse(p).taskId) }),
    'task.sendInput': (_ws, p) => {
      const { taskId, data } = taskIdParams.extend({ data: z.string() }).parse(p);
      tasks.sendInput(taskId, data);
      return { ok: true };
    },
    'task.subscribe': (ws, p) => {
      const { taskId } = taskIdParams.parse(p);
      tasks.getTask(taskId);
      (subscriptions.get(ws) ?? subscriptions.set(ws, new Set()).get(ws)!).add(taskId);
      return { buffer: tasks.getTerminalBuffer(taskId), seq: tasks.getTerminalSeq(taskId) };
    },
    'task.unsubscribe': (ws, p) => {
      subscriptions.get(ws)?.delete(taskIdParams.parse(p).taskId);
      return { ok: true };
    },
    'approval.resolve': (_ws, p) => {
      const input = z
        .object({ approvalId: z.string(), decision: z.enum(['approve', 'deny']), rememberForTask: z.boolean().optional() })
        .parse(p);
      if (!repo.getApproval(input.approvalId)) throw new ServiceError(404, 'approval not found');
      return { approval: approvals.resolve(input.approvalId, input.decision, 'web_ui', input.rememberForTask) };
    },
    'git.merge': async (_ws, p) => {
      const { taskId, ...rest } = taskIdParams.extend({ targetBranch: z.string().optional(), squash: z.boolean().optional() }).parse(p);
      return tasks.merge(taskId, MergeInputSchema.parse(rest), 'web_ui');
    },
    'agent.health': async () => ({ agents: await agentHealth(deps) }),
  };

  app.get('/ws', { websocket: true }, (ws) => {
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      subscriptions.delete(ws);
    });

    ws.on('message', async (raw) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(String(raw)) as JsonRpcRequest;
      } catch {
        return send(ws, { jsonrpc: '2.0', id: null, error: { code: RpcErrors.parse, message: 'parse error' } });
      }
      if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string') {
        return send(ws, { jsonrpc: '2.0', id: req?.id ?? null, error: { code: RpcErrors.invalidRequest, message: 'invalid request' } });
      }
      const handler = methods[req.method];
      if (!handler) {
        return send(ws, { jsonrpc: '2.0', id: req.id ?? null, error: { code: RpcErrors.methodNotFound, message: `unknown method ${req.method}` } });
      }
      try {
        const result = await handler(ws, req.params);
        if (req.id !== undefined) send(ws, { jsonrpc: '2.0', id: req.id, result });
      } catch (err) {
        const e = err as Error;
        const code =
          e instanceof z.ZodError ? RpcErrors.invalidParams : e instanceof ServiceError && e.status === 404 ? RpcErrors.notFound : RpcErrors.internal;
        const message = e instanceof z.ZodError ? 'invalid params' : e instanceof ServiceError ? e.message : 'internal error';
        if (req.id !== undefined) send(ws, { jsonrpc: '2.0', id: req.id, error: { code, message, data: e instanceof z.ZodError ? e.issues : undefined } });
      }
    });
  });
}
