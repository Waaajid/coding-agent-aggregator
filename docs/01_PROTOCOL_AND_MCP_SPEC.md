# Protocol Specification: JSON-RPC 2.0, ACP & MCP Tools

## 1. Manager Agent MCP Tool Definitions
Expose these tools via `@modelcontextprotocol/sdk` so the Manager Agent (Claude Code) can programmatically orchestrate workers.

### `delegate_task`
Creates an isolated git worktree and launches a worker agent asynchronously.
* **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "repo_path": { "type": "string", "description": "Absolute path to the git repository root" },
      "base_branch": { "type": "string", "default": "main" },
      "agent": { "type": "string", "enum": ["claude", "codex", "antigravity", "gemini", "custom"] },
      "title": { "type": "string", "description": "Short slug for branch naming and UI display" },
      "prompt": { "type": "string", "description": "Detailed task specification and file targets" },
      "verify_command": { "type": "string", "description": "Optional shell command run after agent exits (e.g. 'npm test')" },
      "approval_policy": { "type": "string", "enum": ["auto_edit", "ask_shell", "ask_all"], "default": "ask_shell" }
    },
    "required": ["repo_path", "agent", "title", "prompt"]
  }
  ```
* **Returns:** `{ "task_id": "tsk_01J...", "worktree_path": "...", "branch": "agent/codex/tsk_01J...", "status": "running" }`

### `check_task_status`
Polls or blocks (long-poll up to `wait_seconds`) until one or more tasks change state.
* **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "task_ids": { "type": "array", "items": { "type": "string" } },
      "wait_seconds": { "type": "number", "default": 15, "maximum": 60 }
    },
    "required": ["task_ids"]
  }
  ```
* **Returns:** Array of `{ "task_id", "agent", "status": "queued|running|waiting_approval|verifying|completed|failed|rate_limited", "exit_code", "verify_output_tail", "changed_files_count" }`

### `read_worker_diff`
Returns the unified git diff and commit/file summary for a worker's worktree against `base_branch`.
* **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "task_id": { "type": "string" },
      "file_filter": { "type": "string", "description": "Optional relative glob/path" },
      "max_lines": { "type": "number", "default": 500 }
    },
    "required": ["task_id"]
  }
  ```

### `send_feedback`
Sends a follow-up prompt or stdin response into an existing worker session/worktree without losing branch state.
* **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "task_id": { "type": "string" },
      "message": { "type": "string" }
    },
    "required": ["task_id", "message"]
  }
  ```

### `merge_worktree`
Performs a safe staging merge of the worker's branch into `target_branch` and cleans up the worktree on success.
* **Input Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "task_id": { "type": "string" },
      "target_branch": { "type": "string", "default": "main" },
      "squash": { "type": "boolean", "default": true },
      "commit_message": { "type": "string" }
    },
    "required": ["task_id"]
  }
  ```

---

## 2. Internal Daemon JSON-RPC 2.0 / WebSocket Events
All communication between the Web UI, Mobile Client, and Daemon uses JSON-RPC 2.0 over WebSocket (`ws://127.0.0.1:4173/ws?token=...`).

### Client -> Daemon Requests
* `task.create` / `task.cancel` / `task.retry`
* `task.sendInput` `{ taskId, data }` (raw PTY keystrokes or structured message)
* `approval.resolve` `{ approvalId, decision: "approve" | "deny", rememberForTask?: boolean }`
* `git.merge` `{ taskId, targetBranch, squash }`
* `agent.health` (checks installed CLI binaries, auth status, and recent rate-limit cooldowns)

### Daemon -> Client Push Notifications
* `task.updated` `{ taskId, status, updatedAt, metrics }`
* `pty.data` `{ taskId, chunk, seq }` (throttled at 16ms / 60fps for smooth `xterm.js` rendering)
* `approval.requested` `{ approvalId, taskId, agent, toolName, commandOrPath, diffPreview, createdAt }`
* `agent.rateLimited` `{ agent, resetAt, fallbackSuggested }`
