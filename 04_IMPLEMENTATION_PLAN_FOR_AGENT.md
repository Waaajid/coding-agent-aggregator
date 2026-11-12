# Step-by-Step Build Plan (Hand-Off Instructions for Your Coding Agent)

Execute the implementation in 4 milestones. Do not skip verification steps between milestones.

## Monorepo Structure
```text
coding-agent-aggregator/
├── package.json                 # pnpm workspaces root
├── pnpm-workspace.yaml
├── packages/
│   ├── shared/                  # Zod schemas, JSON-RPC types, Event types
│   ├── daemon/                  # Fastify HTTP/WS server, SQLite, Git Worktree & PTY manager
│   │   └── src/
│   │       ├── db/              # SQLite connection + migrations (03_DATABASE_AND_API_SCHEMA.sql)
│   │       ├── git/             # WorktreeManager.ts (create, diff, stagingMerge, cleanup)
│   │       ├── adapters/        # ClaudeAdapter, CodexAdapter, AntigravityAdapter, Registry
│   │       ├── hooks/           # PreToolUse hook binary/script for Claude Code approval gating
│   │       ├── runtime/         # TaskRunner.ts (node-pty lifecycle, ring buffer, rate-limit router)
│   │       └── server/          # Fastify REST + WebSocket JSON-RPC server
│   ├── mcp-server/              # MCP stdio/HTTP bridge exposing delegate_task, check_task_status, etc.
│   └── web/                     # React + Vite + Tailwind + xterm.js + diff2html Control Plane
```

---

## Milestone 1: Core Daemon, SQLite & Git Worktree Manager
1. Initialize a `pnpm` TypeScript monorepo with `packages/shared`, `packages/daemon`, `packages/mcp-server`, and `packages/web`.
2. Implement SQLite initialization in `packages/daemon/src/db` using `better-sqlite3` and the schema in `03_DATABASE_AND_API_SCHEMA.sql`.
3. Implement `WorktreeManager`:
   * `createWorktree(repoPath, baseBranch, agentId, taskId)` -> creates `.aggregator/worktrees/<taskId>`, ensures `.aggregator/` is ignored in `.git/info/exclude`, copies `.env*` files.
   * `getDiff(worktreePath, baseBranch)` -> stages untracked files (`git add -N .`) so new files appear in `git diff`, then returns unified diff + file stats.
   * `mergeWorktree(repoPath, worktreePath, branchName, targetBranch, squash)` -> performs staging merge check, merges cleanly, and removes worktree.
4. **Verify:** Write unit tests creating a temporary git repo, spawning two concurrent worktrees, modifying files in both, and cleanly merging both into `main`.

## Milestone 2: Agent Adapters, PTY Runner & Hook Approval Gate
1. Implement `ClaudeAdapter`, `CodexAdapter`, and `AntigravityAdapter` conforming to `02_AGENT_ADAPTERS_AND_GIT_ENGINE.md`.
2. Implement `TaskRunner` using `node-pty` to spawn processes inside each task's `worktreePath`, stream chunks to `task_logs` and WebSocket subscribers, and detect rate limits (`429` / quota messages).
3. Implement `aggregator-hook.js` (for Claude Code `PreToolUse` hooks) which POSTs tool execution requests to `/internal/approvals` and long-polls until resolved in SQLite.
4. **Verify:** Run a test task via REST API (`POST /api/tasks`) that triggers a mock CLI or real `codex` / `claude` command in a worktree and captures its diff.

## Milestone 3: MCP Server (Replacing `ORCHESTRATOR.md`)
1. Build `packages/mcp-server` using `@modelcontextprotocol/sdk` (`StdioServerTransport`).
2. Implement all 5 tools defined in `01_PROTOCOL_AND_MCP_SPEC.md` (`delegate_task`, `check_task_status`, `read_worker_diff`, `send_feedback`, `merge_worktree`) forwarding calls to the local Daemon HTTP API.
3. Output a ready-to-use `claude_mcp_config.json` snippet so the user can attach the MCP server to Claude Code immediately.
4. **Verify:** Launch Claude Code with this MCP server attached and ask it to delegate two parallel tasks to worker agents on a sample repo.

## Milestone 4: Unified Web & Mobile Control Plane
1. Build `packages/web` using Vite + React + TypeScript + Tailwind CSS:
   * **Top Bar:** Repo selector, Agent Health & Rate-Limit badges (`Claude`, `Codex`, `Antigravity`), Pending Approvals counter.
   * **Multi-Pane Worker Grid:** Live `xterm.js` terminal tabs for each active worktree + status pill + quick input box.
   * **Approval Drawer / Mobile View:** Responsive mobile-first card stack showing pending shell/file approvals with one-tap **Approve** / **Deny** buttons and Web Push / Browser Notification alerts.
   * **Diff & Merge Inspector:** Syntax-highlighted git diff viewer per worktree with **Request Changes (Send Feedback)** and **Squash & Merge** actions.
2. Add startup banner printing the local URL (`http://127.0.0.1:4173`) and Tailscale/LAN URL with auth token QR code for instant mobile pairing.
