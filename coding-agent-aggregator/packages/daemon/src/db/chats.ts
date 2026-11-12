import type { Db } from './index.js';

export interface ChatRecord {
  id: string;
  repoPath: string;
  title: string;
  sessionId: string | null;
  createdAt: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  id: number;
  chatId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

const toChat = (r: Row): ChatRecord => ({
  id: r.id as string,
  repoPath: r.repo_path as string,
  title: r.title as string,
  sessionId: (r.session_id as string) ?? null,
  createdAt: r.created_at as number,
});

const toMessage = (r: Row): ChatMessage => ({
  id: r.id as number,
  chatId: r.chat_id as string,
  role: r.role as ChatRole,
  content: r.content as string,
  createdAt: r.created_at as number,
});

export class ChatRepo {
  constructor(private readonly db: Db) {}

  insertChat(id: string, repoPath: string, title: string): ChatRecord {
    this.db.prepare('INSERT INTO chats (id, repo_path, title, created_at) VALUES (?, ?, ?, ?)').run(id, repoPath, title, Date.now());
    return this.getChat(id)!;
  }

  getChat(id: string): ChatRecord | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  listChats(): ChatRecord[] {
    return (this.db.prepare('SELECT * FROM chats ORDER BY created_at DESC, id DESC').all() as Row[]).map(toChat);
  }

  setSession(id: string, sessionId: string): void {
    this.db.prepare('UPDATE chats SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  addMessage(chatId: string, role: ChatRole, content: string): ChatMessage {
    const res = this.db.prepare('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chatId, role, content, Date.now());
    return toMessage(this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(res.lastInsertRowid) as Row);
  }

  messages(chatId: string, afterId = 0): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id').all(chatId, afterId) as Row[]).map(toMessage);
  }
}
