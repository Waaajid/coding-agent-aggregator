# Coding Agent Aggregator — Technical PRD & System Architecture

## 1. Objective & Vision
Build a local-first, headless **Coding Agent Aggregator Daemon + Unified Web/Mobile Control Plane** that replaces manual `ORCHESTRATOR.md` file juggling with programmatic multi-agent orchestration.

The system allows a **Manager Agent** (e.g., Claude Code) to decompose tasks and dispatch parallel execution jobs to **Worker Agents** (e.g., OpenAI Codex CLI, Antigravity, Gemini CLI, OpenCode) inside isolated `git worktree` environments, while providing the human operator with a unified local/mobile UI for live terminal streaming, diff review, merge approval, and permission gating.

---

## 2. Core Architectural Components

```
+-------------------------------------------------------------------+
|                   Unified Control Plane (Web / Mobile)            |
|  - Multi-Pane PTY Terminal Viewer   - Unified Approval Queue      |
|  - Per-Worktree Git Diff & Merge    - Rate-Limit & Token Monitor  |
+---------------------------------+---------------------------------+
                                  | WebSocket / HTTP (JSON-RPC 2.0)
                                  | (Localhost + Optional Tailscale/E2EE Tunnel)
+---------------------------------v---------------------------------+
|                 Aggregator Daemon (Node.js / TypeScript)          |
|                                                                   |
|  +-----------------------+    +--------------------------------+  |
|  | MCP Server (stdio/SSE)|    | Task & State Store (SQLite)    |  |
|  | - delegate_task       |    | - Tasks, Worktrees, Logs       |  |
|  | - check_task_status   |    | - Approval Events, Usage Stats |  |
|  | - read_worker_diff    |    +--------------------------------+  |
|  | - send_feedback       |                                        |
|  | - merge_worktree      |    +--------------------------------+  |
|  +-----------------------+    | Git Worktree Manager           |  |
|                               | - Auto-branch & isolate        |  |
|  +-----------------------+    | - Staging merge & conflict chk |  |
|  | Adapter & PTY Runtime |    +--------------------------------+  |
|  | - Claude Code Adapter |                                        |
|  | - Codex CLI Adapter   |    +--------------------------------+  |
|  | - Antigravity Adapter |    | Permission & Hook Interceptor  |  |
|  +-----------------------+    +--------------------------------+  |
+-------------------------------------------------------------------+
```

### 2.1 Aggregator Daemon (`packages/daemon`)
* **Runtime:** Node.js (v22+) + TypeScript + Fastify (HTTP/WS) + `better-sqlite3` (persistent state) + `node-pty` (pseudo-terminal management).
* **Role:** Single source of truth for active repositories, tasks, worker processes, git worktrees, and approval gates.

### 2.2 MCP Control Server (`packages/mcp-server`)
* **Transport:** `stdio` (for direct attachment to Claude Code / Desktop) and `SSE / Streamable HTTP` (for remote/daemon attachment).
* **Role:** Exposes orchestration primitives directly as native tools to the Manager Agent so it no longer needs to write/poll `ORCHESTRATOR.md`.

### 2.3 Git Worktree Isolation Engine (`packages/daemon/src/git`)
* Every delegated task spawns an isolated worktree under `<repo>/.aggregator/worktrees/<task-id>` on branch `agent/<agent-name>/<task-id>`.
* Eliminates file lock collisions, dirty working tree overwrites, and build cache corruption when multiple agents edit the codebase concurrently.

### 2.4 Agent Runtime Adapters (`packages/daemon/src/adapters`)
* Normalizes CLI flags, headless JSON output streams, interactive PTY prompts, and Agent Communication Protocol (ACP) / JSON-RPC interfaces across heterogeneous coding agents:
  * **Claude Code Adapter:** Supports `claude -p --output-format stream-json` or interactive `node-pty` + PreToolUse hook interception.
  * **Codex CLI Adapter:** Supports `codex exec --json` / `codex --approval-mode` over `node-pty`.
  * **Antigravity / Custom CLI Adapter:** Configurable command template + regex/ACP prompt detector + file-system watcher fallback.

### 2.5 Unified Web & Mobile Control Plane (`packages/web`)
* **Stack:** React 19 + Vite + Tailwind CSS + `xterm.js` (live terminal rendering) + `diff2html` (side-by-side git diffs).
* **Remote Access:** Binds to `127.0.0.1:4173` by default; supports Tailscale Serve or an E2EE WebSocket relay with Web Push notifications when any worker agent blocks on a permission prompt.

---

## 3. End-to-End Execution Lifecycle
1. **User Goal:** User gives a high-level goal to the Manager Agent (Claude Code) via terminal or Mobile Web UI.
2. **Decomposition:** Manager Agent inspects the repo and calls `delegate_task` for 2–3 independent sub-tasks (e.g., Backend API -> `codex`, Frontend UI -> `antigravity`, E2E Tests -> `claude`).
3. **Isolation:** Daemon creates a dedicated `git worktree` and branch for each `task_id`, copies `.env` / symlinks `node_modules` (optional fast-bootstrap), and spawns the worker adapter.
4. **Execution & Interception:** Worker streams stdout/JSON events to SQLite and WebSockets. If a worker requests shell/write approval or hits a rate limit, the Daemon pauses execution and pushes an approval card to the UI.
5. **Verification & Feedback Loop:** Once a worker exits, the Daemon optionally runs a configured verification command (e.g., `npm test` or `tsc --noEmit`). Manager Agent calls `check_task_status` and `read_worker_diff`. If tests fail or review issues are found, Manager calls `send_feedback` to resume the worker in the same worktree.
6. **Staging Merge:** When satisfied, Manager (or human via UI) triggers `merge_worktree`. Daemon performs a dry-run merge in a temporary staging worktree; if clean, merges into the target branch and cleans up the worktree. If conflicts exist, spawns a conflict-resolution task for Claude.

---

## 4. Non-Functional Requirements
* **Zero Cloud Lock-in:** 100% local execution using existing CLI subscriptions (no extra API token markup).
* **Crash Recovery:** All task metadata, worktree paths, and terminal ring-buffers persisted in SQLite so daemon restarts do not orphan git worktrees.
* **Security:** Local auth token (`~/.aggregator/secret.key`) required for all HTTP/WS calls; shell approval policies configurable (`auto-approve-safe`, `ask-always`, `sandbox-only`).
