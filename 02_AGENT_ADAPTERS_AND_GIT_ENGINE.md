# Agent Runtime Adapters & Git Worktree Engine

## 1. Agent Adapter Interface (`packages/daemon/src/adapters/types.ts`)
Every coding CLI or ACP-compatible agent implements a unified adapter interface so the daemon treats them identically:

```typescript
export type AgentId = 'claude' | 'codex' | 'antigravity' | 'gemini' | 'custom';

export interface SpawnContext {
  taskId: string;
  worktreePath: string;
  prompt: string;
  approvalPolicy: 'auto_edit' | 'ask_shell' | 'ask_all';
  env: Record<string, string>;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  detectInstalled(): Promise<{ installed: boolean; version?: string; binaryPath?: string }>;
  buildCommand(ctx: SpawnContext): { command: string; args: string[]; usePty: boolean };
  parseOutputChunk?(raw: string): ParsedAgentEvent[];
  detectRateLimit(raw: string): { isRateLimited: boolean; retryAfterSeconds?: number };
  detectApprovalPrompt?(raw: string): { detected: boolean; actionSummary: string } | null;
}
```

### Concrete Adapter Strategies
1. **Claude Code (`claude`):**
   * **Headless Mode:** `claude -p "<prompt>" --output-format stream-json --verbose`
   * **Interactive / Hook Mode:** Spawn inside `node-pty` and inject a temporary `.claude/settings.local.json` inside the worktree configuring a `PreToolUse` hook script (`aggregator-hook.js`). Whenever Claude attempts `Bash` or `Write`, the hook makes a synchronous HTTP POST to `http://127.0.0.1:4173/internal/hook-approval`, blocking cleanly until the user taps **Approve** in the Web/Mobile UI!
2. **OpenAI Codex CLI (`codex`):**
   * **Headless Mode:** `codex exec --json "<prompt>"` (parses JSONL events for tool calls, file edits, and final message).
   * **Interactive PTY Mode:** Spawn `codex --approval-mode suggest` inside `node-pty`, intercepting terminal approval prompts via regex/ANSI parser and surfacing them to the Unified Approval Queue.
3. **Antigravity / Custom Agents (`antigravity`):**
   * Configurable via `~/.aggregator/agents.json`:
     ```json
     {
       "antigravity": {
         "command": "antigravity",
         "argsTemplate": ["run", "--cwd", "{{worktreePath}}", "--task", "{{prompt}}"],
         "usePty": true,
         "rateLimitRegex": "(rate limit|429|quota exceeded)"
       }
     }
     ```
   * Also supports **ACP (Agent Communication Protocol)** over stdio/JSON-RPC for any agent implementing ACP natively.

---

## 2. Git Worktree Isolation & Safe Merge Engine

### Worktree Creation Flow
```bash
# 1. Ensure .aggregator/ is in .git/info/exclude so git status stays clean
# 2. Create branch and worktree from base_branch
git worktree add -b agent/<agent>/<taskId> <repo>/.aggregator/worktrees/<taskId> <baseBranch>
```
* **Fast Environment Hydration:** Copy `.env*` files from the root repository into the worktree if present (configurable via `.aggregator.json`). Optionally symlink heavy read-only caches if safe, or run `pnpm install --offline` / `uv sync`.

### Conflict-Safe Merge Flow
Never merge directly into the user's checked-out branch without testing first:
1. Create a temporary staging worktree at `.aggregator/staging/<mergeId>` checked out to `targetBranch`.
2. Run `git merge --no-commit --no-ff agent/<agent>/<taskId>`.
3. **If Exit Code === 0:** Commit the merge (`--squash` if requested), fast-forward `targetBranch`, and remove both staging and worker worktrees.
4. **If Merge Conflict:** Abort staging merge, collect conflicted file list (`git diff --name-only --diff-filter=U`), and return `{ status: "conflict", conflictedFiles }` to the Manager Agent so Claude can automatically resolve the conflict in a dedicated resolution worktree.
