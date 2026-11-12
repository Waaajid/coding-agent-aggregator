export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export const RpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  notFound: -32004,
} as const;

/** Daemon -> client push notifications (JSON-RPC notifications, no id). */
export type ServerNotification =
  | { method: 'task.updated'; params: { taskId: string; status: string; updatedAt: number } }
  | { method: 'pty.data'; params: { taskId: string; chunk: string; seq: number } }
  | { method: 'approval.requested'; params: Record<string, unknown> }
  | { method: 'approval.resolved'; params: { approvalId: string; taskId: string; status: string } }
  | { method: 'agent.rateLimited'; params: { agent: string; resetAt: number | null; fallbackSuggested: string | null } };
