export class AuthError extends Error {}

/** REST client for the daemon (same origin, bearer token). */
export class Api {
  constructor(
    private readonly token: string,
    private readonly onUnauthorized: () => void,
  ) {}

  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-aggregator-client': window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'web',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.onUnauthorized();
      throw new AuthError('unauthorized');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error ?? `request failed (${res.status})`);
    return data as T;
  }
}

type Handler = (params: any) => void;

/** JSON-RPC 2.0 WebSocket client with automatic reconnect. */
export class Socket {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private retry = 0;
  private closed = false;
  private timer?: number;

  constructor(
    private readonly token: string,
    private readonly onStatus: (s: 'connecting' | 'open' | 'closed') => void,
    private readonly onOpen: () => void,
  ) {}

  connect(): void {
    this.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`, ['aggregator.v1', `bearer.${this.token}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && msg.id !== null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('connection lost'));
      this.pending.clear();
      this.onStatus('closed');
      if (!this.closed) this.timer = window.setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 10_000));
    };
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.ws?.close();
  }

  rpc<T = any>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  on(method: string, handler: Handler): () => void {
    const set = this.handlers.get(method) ?? new Set();
    this.handlers.set(method, set);
    set.add(handler);
    return () => set.delete(handler);
  }
}
