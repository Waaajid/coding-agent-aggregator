import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Source of truth: 03_DATABASE_AND_API_SCHEMA.sql, plus `session_id` (native agent resume)
// and the `cancelled` status.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker',
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    approval_policy TEXT NOT NULL DEFAULT 'ask_shell',
    verify_command TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    exit_code INTEGER,
    verify_output TEXT,
    error_message TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);

CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id, id);

CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    raw_payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_by TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);

CREATE TABLE IF NOT EXISTS agent_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    duration_ms INTEGER,
    retry_after_seconds INTEGER,
    created_at INTEGER NOT NULL
);

-- Manager chat: a conversation with a manager agent session that orchestrates workers through the MCP tools.
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    title TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'user' | 'assistant' | 'tool' | 'system'
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id);
`;

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
