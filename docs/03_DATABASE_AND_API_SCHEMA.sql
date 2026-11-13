-- SQLite Schema for Coding Agent Aggregator Daemon
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
    agent_id TEXT NOT NULL, -- 'claude' | 'codex' | 'antigravity' | 'gemini' | 'custom'
    role TEXT NOT NULL DEFAULT 'worker', -- 'manager' | 'worker'
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    approval_policy TEXT NOT NULL DEFAULT 'ask_shell',
    verify_command TEXT,
    status TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'waiting_approval' | 'verifying' | 'completed' | 'failed' | 'rate_limited' | 'merged'
    exit_code INTEGER,
    verify_output TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);

CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    stream TEXT NOT NULL, -- 'pty' | 'json_event' | 'system' | 'verify'
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
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'denied' | 'expired'
    resolved_by TEXT, -- 'web_ui' | 'mobile_ui' | 'manager_agent' | 'policy'
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);

CREATE TABLE IF NOT EXISTS agent_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, -- 'task_started' | 'task_completed' | 'rate_limited'
    duration_ms INTEGER,
    retry_after_seconds INTEGER,
    created_at INTEGER NOT NULL
);
