import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DaemonClient, DaemonError } from './client.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: err instanceof DaemonError ? err.message : `Unexpected error: ${(err as Error).message}` }],
});

async function guard(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (err) {
    return fail(err);
  }
}

/** The orchestration primitives from spec 01, exposed to the manager agent as MCP tools. */
export function createServer(client: DaemonClient): McpServer {
  const server = new McpServer({ name: 'aggregator', version: '0.1.0' });

  server.registerTool(
    'delegate_task',
    {
      description:
        'Create an isolated git worktree + branch and launch a worker agent on it asynchronously. Returns immediately with a task_id; ' +
        'use check_task_status to follow progress. Delegate independent sub-tasks in parallel (each worker has its own copy of the repo).',
      inputSchema: {
        repo_path: z.string().describe('Absolute path to the git repository root'),
        base_branch: z.string().default('main').describe('Branch the worker branches from'),
        agent: z.enum(['claude', 'codex', 'antigravity', 'gemini', 'custom']).describe('Which worker agent to use (see agent_health for what is installed)'),
        title: z.string().min(1).max(80).describe('Short slug for branch naming and UI display'),
        prompt: z.string().min(1).describe('Detailed, self-contained task specification and file targets'),
        verify_command: z.string().optional().describe("Optional shell command run after the agent exits, e.g. 'npm test'"),
        approval_policy: z.enum(['auto_edit', 'ask_shell', 'ask_all']).default('ask_shell'),
      },
    },
    ({ repo_path, base_branch, agent, title, prompt, verify_command, approval_policy }) =>
      guard(async () => {
        const { task, warnings } = await client.request('POST', '/api/tasks', {
          repoPath: repo_path,
          baseBranch: base_branch,
          agent,
          title,
          prompt,
          verifyCommand: verify_command,
          approvalPolicy: approval_policy,
        });
        return { task_id: task.id, worktree_path: task.worktreePath, branch: task.branchName, status: task.status, ...(warnings.length ? { warnings } : {}) };
      }),
  );

  server.registerTool(
    'check_task_status',
    {
      description:
        'Poll, or long-poll (up to wait_seconds), until one or more tasks change state. Returns immediately if any task already finished or is ' +
        'waiting for a human approval. Statuses: queued, running, waiting_approval, verifying, completed, failed, rate_limited, cancelled, merged.',
      inputSchema: {
        task_ids: z.array(z.string()).min(1),
        wait_seconds: z.number().min(0).max(60).default(15),
      },
    },
    ({ task_ids, wait_seconds }) =>
      guard(async () => {
        const q = new URLSearchParams({ ids: task_ids.join(','), wait: String(wait_seconds) });
        return (await client.request('GET', `/api/tasks/status?${q}`)).tasks;
      }),
  );

  server.registerTool(
    'read_worker_diff',
    {
      description: "Unified git diff and file summary of a worker's work against its base branch (includes new files).",
      inputSchema: {
        task_id: z.string(),
        file_filter: z.string().optional().describe('Optional relative path/glob'),
        max_lines: z.number().int().min(1).default(500),
      },
    },
    ({ task_id, file_filter, max_lines }) =>
      guard(async () => {
        const q = new URLSearchParams({ maxLines: String(max_lines) });
        if (file_filter) q.set('file', file_filter);
        const d = await client.request('GET', `/api/tasks/${encodeURIComponent(task_id)}/diff?${q}`);
        const summary = d.files.map((f: any) => `${f.path} (+${f.added} -${f.deleted})`).join('\n') || '(no changes)';
        return `Branch ${d.branch} vs ${d.base_branch}\nFiles:\n${summary}\n${d.truncated ? `\n[diff truncated to ${max_lines} of ${d.total_lines} lines]\n` : '\n'}${d.diff}`;
      }),
  );

  server.registerTool(
    'send_feedback',
    {
      description:
        'Send a follow-up to an existing worker without losing its branch state. A finished worker is resumed in the same worktree; ' +
        'a worker that is still running headless must finish first.',
      inputSchema: { task_id: z.string(), message: z.string().min(1) },
    },
    ({ task_id, message }) =>
      guard(async () => {
        const { task } = await client.request('POST', `/api/tasks/${encodeURIComponent(task_id)}/feedback`, { message });
        return { task_id: task.id, status: task.status };
      }),
  );

  server.registerTool(
    'merge_worktree',
    {
      description:
        "Request a safe staging merge of a completed worker's branch into target_branch (cleans up the worktree on success). " +
        'By default a human must approve manager-initiated merges in the control plane: the result is then {status:"pending_approval"} and ' +
        'the merge runs automatically once approved; check_task_status will show "merged". Conflicts return {status:"conflict", conflictedFiles}.',
      inputSchema: {
        task_id: z.string(),
        target_branch: z.string().optional().describe("Defaults to the task's base branch"),
        squash: z.boolean().default(true),
        commit_message: z.string().optional(),
      },
    },
    ({ task_id, target_branch, squash, commit_message }) =>
      guard(() =>
        client.request('POST', `/api/tasks/${encodeURIComponent(task_id)}/merge`, {
          targetBranch: target_branch,
          squash,
          commitMessage: commit_message,
        }),
      ),
  );

  server.registerTool(
    'agent_health',
    {
      description: 'Which worker agents are installed, whether they can be approval-gated, and any active rate-limit cooldowns.',
      inputSchema: {},
    },
    () => guard(async () => (await client.request('GET', '/api/agents/health')).agents),
  );

  return server;
}
