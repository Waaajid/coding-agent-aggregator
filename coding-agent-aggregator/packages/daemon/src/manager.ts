import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@aggregator/shared';
import { findOnPath, tryParseJson } from './adapters/util.js';
import type { DaemonConfig } from './config.js';
import type { ChatMessage, ChatRecord, ChatRepo } from './db/chats.js';
import type { Bus } from './events.js';
import { RepoPathError, type WorktreeManager } from './git/WorktreeManager.js';
import { ServiceError } from './runtime/TaskService.js';

export interface ManagerOptions {
  command?: string;
  /** Placed before the CLI's own arguments (tests run `node mock-claude.mjs`). */
  baseArgs?: string[];
  /** Path of the bundled MCP server (`packages/mcp-server/dist/index.mjs`). */
  mcpEntry?: string;
  /** Extra environment for the manager process. */
  extraEnv?: Record<string, string>;
}

export const DEFAULT_MCP_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp-server', 'dist', 'index.mjs');

const systemPrompt = (repoPath: string, branch: string) =>
  [
    'You are the Manager agent of a multi-agent coding team. You do NOT edit code yourself: you plan, delegate, review and report.',
    `The repository is at ${repoPath}; always pass it as repo_path, and use base_branch "${branch}" (the branch currently checked out there).`,
    'Workflow: (1) inspect the repo read-only if needed, (2) split the goal into 2-3 independent sub-tasks and call delegate_task for each in parallel with self-contained prompts,',
    '(3) follow progress with check_task_status, (4) review results with read_worker_diff, (5) use send_feedback for fixes, (6) request merge_worktree for good work.',
    'Merges need human approval in the control plane; tell the user when you are waiting for it. Call agent_health first if unsure which worker agents are installed.',
    'Keep replies short and concrete. Tell the user what you delegated and the task ids.',
  ].join('\n');

/** A conversation with a manager agent session that orchestrates workers via the aggregator MCP tools. */
export class ManagerService {
  private readonly runs = new Map<string, ChildProcess>();
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly mcpEntry: string;
  private readonly extraEnv: Record<string, string>;

  constructor(
    private readonly chats: ChatRepo,
    private readonly bus: Bus,
    private readonly wm: WorktreeManager,
    private readonly config: Pick<DaemonConfig, 'home' | 'managerToken'>,
    private readonly daemonUrl: () => string,
    opts: ManagerOptions = {},
  ) {
    this.command = opts.command ?? 'claude';
    this.baseArgs = opts.baseArgs ?? [];
    this.mcpEntry = opts.mcpEntry ?? DEFAULT_MCP_ENTRY;
    this.extraEnv = opts.extraEnv ?? {};
  }

  async createChat(repoPath: string): Promise<ChatRecord> {
    let root: string;
    try {
      root = await this.wm.resolveRepoRoot(repoPath);
    } catch (err) {
      throw new ServiceError(400, err instanceof RepoPathError ? err.message : `repo_path is not a git repository: ${repoPath}`);
    }
    return this.chats.insertChat(newId('cht'), root, basename(root));
  }

  getChat(id: string): ChatRecord {
    const chat = this.chats.getChat(id);
    if (!chat) throw new ServiceError(404, `chat not found: ${id}`);
    return chat;
  }

  listChats(): Array<ChatRecord & { busy: boolean }> {
    return this.chats.listChats().map((c) => ({ ...c, busy: this.runs.has(c.id) }));
  }

  messages(id: string, afterId = 0): ChatMessage[] {
    this.getChat(id);
    return this.chats.messages(id, afterId);
  }

  isBusy(id: string): boolean {
    return this.runs.has(id);
  }

  async send(chatId: string, text: string): Promise<ChatMessage> {
    const chat = this.getChat(chatId);
    if (this.runs.has(chatId)) throw new ServiceError(409, 'the manager is still working on the previous message');
    const userMessage = this.post(chatId, 'user', text);

    if (!findOnPath(this.command)) {
      this.post(chatId, 'system', `The "${this.command}" CLI was not found on PATH, so the manager cannot run.`);
      return userMessage;
    }
    if (!existsSync(this.mcpEntry)) {
      this.post(chatId, 'system', `The MCP server is not built (${this.mcpEntry}). Run "npm run build" and try again.`);
      return userMessage;
    }

    const mcpConfigPath = join(this.config.home, 'manager-mcp.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          aggregator: {
            command: process.execPath,
            args: [this.mcpEntry],
            env: { AGGREGATOR_URL: this.daemonUrl(), AGGREGATOR_MANAGER_TOKEN: this.config.managerToken },
          },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(mcpConfigPath, 0o600);

    const args = [
      ...this.baseArgs,
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      // The manager may read the repo and call the aggregator tools; nothing else (no shell, no edits).
      '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'mcp__aggregator,Read,Glob,Grep',
      '--append-system-prompt', systemPrompt(chat.repoPath, await this.wm.currentBranch(chat.repoPath)),
    ];
    if (chat.sessionId) args.push('--resume', chat.sessionId);

    const child = spawn(this.command, args, {
      cwd: chat.repoPath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.extraEnv,
        AGGREGATOR_URL: this.daemonUrl(),
        AGGREGATOR_MANAGER_TOKEN: this.config.managerToken,
        AGGREGATOR_CHAT_ID: chatId,
      },
    });
    this.runs.set(chatId, child);
    this.bus.emit('chat.status', { chatId, busy: true });

    let buffered = '';
    let stderr = '';
    let sawResult = false;
    const handleLine = (line: string) => {
      const obj = tryParseJson(line);
      if (!obj) return;
      if (typeof obj.session_id === 'string' && obj.type === 'system') this.chats.setSession(chatId, obj.session_id);
      if (obj.type === 'assistant') {
        const content = (obj.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) this.post(chatId, 'assistant', block.text);
          if (block.type === 'tool_use') this.post(chatId, 'tool', `${String(block.name).replace(/^mcp__aggregator__/, '')} ${JSON.stringify(block.input ?? {})}`);
        }
      }
      if (obj.type === 'result') {
        sawResult = true;
        if (typeof obj.session_id === 'string') this.chats.setSession(chatId, obj.session_id);
        if (obj.is_error === true) this.post(chatId, 'system', `Manager error: ${String(obj.result ?? 'unknown error')}`);
      }
    };

    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      buffered += d;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        handleLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));

    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      if (buffered) handleLine(buffered);
      this.runs.delete(chatId);
      if (signal) this.post(chatId, 'system', 'Stopped.');
      else if (code !== 0 && !sawResult) this.post(chatId, 'system', `The manager exited with code ${code}.${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
      this.bus.emit('chat.status', { chatId, busy: false });
    };
    child.on('error', (err) => {
      this.post(chatId, 'system', `Could not start the manager: ${err.message}`);
      finish(127, null);
    });
    child.on('close', finish);
    return userMessage;
  }

  cancel(chatId: string): boolean {
    const child = this.runs.get(chatId);
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    return true;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runs.keys()]) this.cancel(id);
    const deadline = Date.now() + 5000;
    while (this.runs.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  }

  private post(chatId: string, role: ChatMessage['role'], content: string): ChatMessage {
    const message = this.chats.addMessage(chatId, role, content);
    this.bus.emit('chat.message', message);
    return message;
  }
}
