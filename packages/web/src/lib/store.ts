import { Api, Socket } from './api';
import { STATUS } from './format';
import type { ActivityItem, AgentHealth, ApprovalRecord, Chat, ChatMessage, TaskRecord } from './types';

export type Conn = 'connecting' | 'open' | 'closed';

export interface State {
  conn: Conn;
  tasks: Record<string, TaskRecord>;
  approvals: ApprovalRecord[]; // pending only
  agents: AgentHealth[];
  chats: Chat[];
  messages: Record<string, ChatMessage[]>;
  activity: ActivityItem[];
}

const initial: State = { conn: 'connecting', tasks: {}, approvals: [], agents: [], chats: [], messages: {}, activity: [] };

/** All server state lives here; the WebSocket pushes keep it live and REST fills it in. */
export class Store {
  private state: State = initial;
  private readonly listeners = new Set<() => void>();
  private activityId = 0;
  readonly api: Api;
  readonly ws: Socket;

  constructor(token: string, onUnauthorized: () => void) {
    this.api = new Api(token, onUnauthorized);
    this.ws = new Socket(token, (conn) => this.set({ conn }), () => void this.refreshAll());
    this.bindPushes();
    // A bad token only fails the WebSocket upgrade; probe over REST so the sign-in screen appears instead of "Reconnecting…".
    void this.api.request('GET', '/api/agents/health').catch(() => undefined);
    this.ws.connect();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;

  private set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  dispose() {
    this.ws.close();
  }

  // ---- loading -----------------------------------------------------------------------------------------------
  async refreshAll() {
    await Promise.allSettled([this.loadTasks(), this.loadApprovals(), this.loadAgents(), this.loadChats()]);
  }

  async loadTasks() {
    const { tasks } = await this.api.request<{ tasks: TaskRecord[] }>('GET', '/api/tasks');
    this.set({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) });
  }
  async loadApprovals() {
    const { approvals } = await this.api.request<{ approvals: ApprovalRecord[] }>('GET', '/api/approvals?status=pending');
    this.set({ approvals });
  }
  async loadAgents() {
    const { agents } = await this.api.request<{ agents: AgentHealth[] }>('GET', '/api/agents/health');
    this.set({ agents });
  }
  async loadChats() {
    const { chats } = await this.api.request<{ chats: Chat[] }>('GET', '/api/chats');
    this.set({ chats });
  }
  async loadMessages(chatId: string) {
    const { messages, busy } = await this.api.request<{ messages: ChatMessage[]; busy: boolean }>('GET', `/api/chats/${chatId}/messages`);
    this.set((s) => ({
      messages: { ...s.messages, [chatId]: messages },
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, busy } : c)),
    }));
  }

  // ---- actions -----------------------------------------------------------------------------------------------
  createTask(body: Record<string, unknown>) {
    return this.api.request<{ task: TaskRecord; warnings: string[] }>('POST', '/api/tasks', body);
  }
  cancelTask = (id: string) => this.api.request('POST', `/api/tasks/${id}/cancel`);
  retryTask = (id: string) => this.api.request('POST', `/api/tasks/${id}/retry`);
  feedback = (id: string, message: string) => this.api.request('POST', `/api/tasks/${id}/feedback`, { message });
  merge = (id: string, squash: boolean) => this.api.request('POST', `/api/tasks/${id}/merge`, { squash });
  resolveApproval = (id: string, decision: 'approve' | 'deny', rememberForTask = false) =>
    this.api.request('POST', `/api/approvals/${id}/resolve`, { decision, rememberForTask });

  async createChat(repoPath: string): Promise<Chat> {
    const { chat } = await this.api.request<{ chat: Chat }>('POST', '/api/chats', { repoPath });
    this.set((s) => ({ chats: [{ ...chat, busy: false }, ...s.chats], messages: { ...s.messages, [chat.id]: [] } }));
    return chat;
  }
  sendChat = (chatId: string, message: string) => this.api.request('POST', `/api/chats/${chatId}/messages`, { message });
  cancelChat = (chatId: string) => this.api.request('POST', `/api/chats/${chatId}/cancel`);

  // ---- pushes ------------------------------------------------------------------------------------------------
  private log(kind: ActivityItem['kind'], text: string, taskId?: string) {
    const item: ActivityItem = { id: ++this.activityId, at: Date.now(), kind, text, taskId };
    this.set((s) => ({ activity: [item, ...s.activity].slice(0, 80) }));
  }

  private taskTitle(id: string) {
    return this.state.tasks[id]?.title ?? id;
  }

  private bindPushes() {
    const { ws } = this;
    ws.on('task.created', ({ task }: { task: TaskRecord }) => {
      this.set((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
      this.log('info', `${task.agentId} was given “${task.title}”`, task.id);
    });

    ws.on('task.updated', async ({ taskId, status }: { taskId: string; status: TaskRecord['status'] }) => {
      const before = this.state.tasks[taskId]?.status;
      try {
        const { task } = await this.api.request<{ task: TaskRecord }>('GET', `/api/tasks/${taskId}`);
        this.set((s) => ({ tasks: { ...s.tasks, [taskId]: task } }));
        if (before !== status) {
          const kind = status === 'completed' || status === 'merged' ? 'success' : status === 'failed' ? 'error' : status === 'rate_limited' || status === 'waiting_approval' ? 'warn' : 'info';
          const extra = status === 'failed' && task.errorMessage ? ` — ${task.errorMessage}` : '';
          this.log(kind, `“${task.title}” → ${STATUS[status].label}${extra}`, taskId);
        }
      } catch {
        /* task vanished or auth failed; the next full refresh will sort it out */
      }
    });

    ws.on('approval.requested', (a: ApprovalRecord & { approvalId: string }) => {
      this.set((s) => ({ approvals: s.approvals.some((x) => x.id === a.id) ? s.approvals : [...s.approvals, a] }));
      this.log('approval', `Approval needed: ${a.toolName} ${a.summary}`, a.taskId);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`Approval needed (${this.taskTitle(a.taskId)})`, { body: `${a.toolName}: ${a.summary}`, tag: a.id });
      }
    });
    ws.on('approval.resolved', ({ approvalId }: { approvalId: string }) => {
      this.set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approvalId) }));
    });

    ws.on('agent.rateLimited', (p: { agent: string; resetAt: number | null; fallbackSuggested: string | null }) => {
      this.log('warn', `${p.agent} hit a rate limit${p.fallbackSuggested ? ` — try ${p.fallbackSuggested}` : ''}`);
      void this.loadAgents();
    });

    ws.on('chat.message', ({ message }: { message: ChatMessage }) => {
      this.set((s) => {
        const list = s.messages[message.chatId] ?? [];
        if (list.some((m) => m.id === message.id)) return {};
        return { messages: { ...s.messages, [message.chatId]: [...list, message] } };
      });
    });
    ws.on('chat.status', ({ chatId, busy }: { chatId: string; busy: boolean }) => {
      this.set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, busy } : c)) }));
    });
  }
}
