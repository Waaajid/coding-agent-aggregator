# Coding Agent Aggregator

Local-first daemon that lets a manager agent (Claude Code) delegate work to worker agents, each in its own
git worktree, with one control plane (web + mobile) to chat with the manager, watch everything live, approve actions,
review diffs and merge. See the spec files one level up (`00`–`04`). **All four milestones are implemented.**

## Quick start

```bash
corepack pnpm install        # or: pnpm install
npm run demo                 # try everything with mock agents: no CLIs, no API usage, throwaway repo
npm start                    # the real thing: builds, then serves http://127.0.0.1:4173
```

`npm start` prints a sign-in link (`http://127.0.0.1:4173/#token=…`; the token is in the URL fragment, never sent to a server).
Open it, then:

1. **Manager** tab → pick your repo → tell the manager a goal. It reads the repo, splits the work, delegates to workers and
   reports back. (It runs a headless Claude session limited to read-only file tools plus the aggregator tools, and needs
   the `claude` CLI logged in.)
2. **Overview** shows every task as a card moving through *Queued → Working → Verify → Review → Merged*, with live counters
   and an activity feed. Amber means it needs you.
3. **Approvals** (and the browser tab title / 🔔 alerts) tell you when a worker is blocked on a permission. One tap to approve or deny.
4. Open a task for the **live terminal**, the **Changes** diff, then **Request changes** (resumes the worker) or **Squash & merge**.

You can also start a worker directly with **+ Task**, or attach the MCP server to your own Claude Code (below).

## Use it from your own Claude Code (MCP)

```bash
npm run mcp:config          # prints a ready-to-use mcpServers snippet; save it as .mcp.json in your repo
```

The server reads the manager token from `~/.aggregator/manager.key` (override with `AGGREGATOR_URL` / `AGGREGATOR_MANAGER_TOKEN`).
Tools: `delegate_task`, `check_task_status`, `read_worker_diff`, `send_feedback`, `merge_worktree` (as in spec 01) plus
`agent_health`. Merges requested this way wait for you in the Approvals tab.

## Phone access

The daemon only binds to `127.0.0.1`. Put Tailscale in front of it and tell the daemon its public URL so it prints a pairing QR code:

```bash
tailscale serve --bg 4173
AGGREGATOR_PUBLIC_URL=https://<machine>.<tailnet>.ts.net npm start
```

Notes: avoid ports on the browser "bad ports" list (e.g. 4190); `npm run build` is only needed again after changing `packages/web` or `packages/mcp-server`.

```bash
corepack pnpm -r typecheck
corepack pnpm -r test        # daemon (real git, PTYs, hook script, mock CLIs), MCP server over stdio, UI helpers
```

## What exists

| Area | Where |
|---|---|
| SQLite schema + queries | `packages/daemon/src/db` |
| Worktree create / diff / auto-commit / staging merge | `packages/daemon/src/git/WorktreeManager.ts` |
| Claude, Codex, config-driven (Antigravity/Gemini/custom) adapters | `packages/daemon/src/adapters` |
| Process runner (node-pty or pipes), ring buffer, 16 ms stream throttle, rate-limit routing | `packages/daemon/src/runtime/TaskRunner.ts` |
| Task lifecycle, queue, verify, feedback/resume, merge gate, crash recovery | `packages/daemon/src/runtime/TaskService.ts` |
| Approval queue + policy engine | `packages/daemon/src/approvals.ts`, `policy.ts` |
| Claude `PreToolUse` hook | `packages/daemon/src/hooks/aggregator-hook.mjs` |
| REST + JSON-RPC/WebSocket server, static UI hosting | `packages/daemon/src/server` |
| Manager chat (headless Claude + MCP, persisted transcript, session resume) | `packages/daemon/src/manager.ts` |
| MCP server (stdio) | `packages/mcp-server` |
| Control plane: overview board, approvals, chat, xterm terminal, diff2html | `packages/web` |

REST lives under `/api` (`tasks`, `tasks/status?ids=&wait=`, `tasks/:id/{diff,logs,cancel,retry,input,feedback,merge}`,
`approvals`, `agents/health`, `chats`, `chats/:id/{messages,cancel}`). Request bodies use camelCase; the MCP server maps the spec's snake_case.

## Configuration

`~/.aggregator/` (override with `AGGREGATOR_HOME`): `secret.key` (admin), `manager.key` (manager agent),
`aggregator.db`, `agents.json` (extra/overriding agents, see spec 02). Env: `AGGREGATOR_PORT`,
`AGGREGATOR_MAX_CONCURRENT` (4), `AGGREGATOR_APPROVAL_TIMEOUT_MS`, `AGGREGATOR_REQUIRE_HUMAN_MERGE=0` to disable the
merge gate, `AGGREGATOR_EXTRA_HOSTS` / `AGGREGATOR_ALLOWED_ORIGINS` for Tailscale/LAN or a dev UI origin.
Per-repo `.aggregator.json`: `{ "copy": ["config/local.json"], "symlink": ["node_modules"] }` (`.env*` always copied).

## Approval policies

- `ask_all` – every edit and shell command needs a human (reads are free).
- `ask_shell` (default) – edits inside the worktree are automatic; shell commands need a human.
- `auto_edit` – like `ask_shell`, plus side-effect-free commands (`git status`, `pnpm test`, …) run automatically.
- Edits outside the worktree always need a human.

Gating needs an adapter that can intercept prompts: Claude (hook) and PTY agents with an `approvalRegex`. Headless
Codex runs in its own sandbox and cannot be gated; the API returns a `warnings` entry when a gating policy was requested.

## Deliberate differences from the spec

1. **Two credentials.** The manager agent's MCP server uses `manager.key`, which cannot resolve approvals; merges it
   requests wait for a human to approve (then run automatically). Otherwise the manager could approve its own work.
2. **Per-task hook token.** Workers get a token valid only for `/internal/approvals` of their own task, not the admin token.
3. **Host + Origin checks** on every request (DNS-rebinding / drive-by CSRF); WebSocket auth is via subprotocol, never the URL.
4. **Single hook endpoint** (`/internal/approvals`) with long-poll `GET /internal/approvals/:id`; the hook fails closed.
5. **`resume`**: Claude resumes natively (`--resume <session_id>`); agents without it get the original task replayed.
6. **Staging merge uses a detached worktree** at the target tip (a branch checked out in the main repo can't be checked out twice);
   the target is advanced by fast-forward, or `update-ref` if it isn't checked out. Dirty overlapping local changes yield `target_dirty`.
7. Added `cancelled` task status and `tasks.session_id`.
8. Rate-limit detection ignores agent *content* (assistant text, tool output) and only inspects error events / stderr-style lines.

9. **Manager chat** is an addition: the UI talks to a daemon-run Claude session (read-only tools + aggregator MCP tools only),
   so you don't need a separate terminal for the manager.

## Known limits

- Workers are children of the daemon: if it is hard-killed, their processes may linger and the task is marked failed
  on restart (the worktree is kept; use retry).
- A manager (or any MCP client) can target any git repo on the machine via `repo_path`; scope-limiting that is not implemented.
- Codex/Gemini/Antigravity CLIs were not installed on the dev machine; their flags are unverified against real binaries
  (Claude's were checked against the installed CLI). Override them in `agents.json` if they differ.
- node-pty's macOS `spawn-helper` can lose its exec bit under pnpm; the daemon repairs it before the first PTY spawn.
