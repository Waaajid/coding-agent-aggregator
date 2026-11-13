import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import * as pty from 'node-pty';
import type { Repo } from '../db/repo.js';
import type { Bus } from '../events.js';
import type { AgentAdapter, ParsedAgentEvent, SpawnContext } from '../adapters/types.js';
import { stripAnsi } from '../adapters/util.js';
import { ensurePtyHelperExecutable } from './ptyHelper.js';

/** Fixed-size tail of a stream, kept for late-joining terminals and crash diagnostics. */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly maxBytes = 256 * 1024) {}

  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

interface ProcessHandle {
  pid: number;
  write(data: string): void;
  signal(sig: NodeJS.Signals): void;
}

export interface RunCallbacks {
  onEvent(event: ParsedAgentEvent): void;
  onRateLimit(info: { retryAfterSeconds?: number }): void;
  /** PTY only. Call `answer` to type the decision into the agent. */
  onApprovalPrompt(info: { actionSummary: string }, answer: (decision: 'approve' | 'deny') => void): void;
  onExit(info: { exitCode: number | null; signal: string | null; rateLimited: boolean; killed: boolean }): void;
}

export interface ActiveRun {
  taskId: string;
  handle: ProcessHandle;
  buffer: RingBuffer;
  usePty: boolean;
  killed: boolean;
  rateLimited: boolean;
  startedAt: number;
}

const FLUSH_MS = 16; // ~60fps for xterm.js
const LOG_FLUSH_MS = 250;
const DETECT_TAIL = 4096;

export class TaskRunner {
  private readonly runs = new Map<string, ActiveRun>();
  /** Terminal output of finished runs stays available until the task is merged/cleaned. */
  private readonly buffers = new Map<string, RingBuffer>();
  private readonly seqs = new Map<string, number>();

  constructor(
    private readonly repo: Repo,
    private readonly bus: Bus,
  ) {}

  isActive(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  usesPty(taskId: string): boolean {
    return this.runs.get(taskId)?.usePty ?? false;
  }

  activeCount(): number {
    return this.runs.size;
  }

  getSeq(taskId: string): number {
    return this.seqs.get(taskId) ?? 0;
  }

  getBuffer(taskId: string): string {
    return this.buffers.get(taskId)?.toString() ?? '';
  }

  dropBuffer(taskId: string): void {
    this.buffers.delete(taskId);
    this.seqs.delete(taskId);
  }

  write(taskId: string, data: string): boolean {
    const run = this.runs.get(taskId);
    if (!run) return false;
    run.handle.write(data);
    return true;
  }

  kill(taskId: string): boolean {
    const run = this.runs.get(taskId);
    if (!run) return false;
    run.killed = true;
    this.terminate(run);
    return true;
  }

  killAll(): void {
    for (const id of [...this.runs.keys()]) this.kill(id);
  }

  start(adapter: AgentAdapter, ctx: SpawnContext, cb: RunCallbacks): ActiveRun {
    const { command, args, usePty } = adapter.buildCommand(ctx);
    const env = { ...process.env, ...adapter.extraEnv, ...ctx.env, TERM: 'xterm-256color' } as Record<string, string>;
    const buffer = this.buffers.get(ctx.taskId) ?? new RingBuffer();
    this.buffers.set(ctx.taskId, buffer);

    const run: ActiveRun = {
      taskId: ctx.taskId,
      buffer,
      usePty,
      killed: false,
      rateLimited: false,
      startedAt: Date.now(),
      handle: undefined as unknown as ProcessHandle,
    };

    // --- output pipeline -------------------------------------------------------------------------
    let pendingOut = '';
    let flushTimer: NodeJS.Timeout | undefined;
    let pendingLog: Array<{ stream: 'pty' | 'json_event'; text: string }> = [];
    let logTimer: NodeJS.Timeout | undefined;
    const partial: Record<string, string> = { stdout: '', stderr: '' };
    let ptyTail = '';

    const flushOut = () => {
      flushTimer = undefined;
      if (!pendingOut) return;
      const seq = (this.seqs.get(ctx.taskId) ?? 0) + 1;
      this.seqs.set(ctx.taskId, seq);
      // The replay buffer only holds output that has been emitted, so buffer + (seq > getSeq) pushes never overlap.
      buffer.push(pendingOut);
      this.bus.emit('pty.data', { taskId: ctx.taskId, chunk: pendingOut, seq });
      pendingOut = '';
    };
    const flushLog = () => {
      logTimer = undefined;
      const batch = pendingLog;
      pendingLog = [];
      for (const entry of batch) this.repo.appendLog(ctx.taskId, entry.stream, entry.text);
    };
    const emit = (text: string, stream: 'pty' | 'json_event') => {
      pendingOut += text;
      flushTimer ??= setTimeout(flushOut, FLUSH_MS);
      const last = pendingLog[pendingLog.length - 1];
      if (last && last.stream === stream) last.text += text;
      else pendingLog.push({ stream, text });
      logTimer ??= setTimeout(flushLog, LOG_FLUSH_MS);
    };

    const handleRateLimit = (text: string) => {
      if (run.rateLimited) return;
      const rl = adapter.detectRateLimit(text);
      if (!rl.isRateLimited) return;
      run.rateLimited = true;
      cb.onRateLimit({ retryAfterSeconds: rl.retryAfterSeconds });
      this.terminate(run);
    };

    const onComplete = (text: string) => {
      // complete lines from a piped agent
      handleRateLimit(text);
      for (const ev of adapter.parseOutputChunk?.(text) ?? []) cb.onEvent(ev);
    };

    const onData = (chunk: string, source: 'pty' | 'stdout' | 'stderr') => {
      if (source === 'pty') {
        emit(chunk, 'pty');
        ptyTail = (ptyTail + stripAnsi(chunk)).slice(-DETECT_TAIL);
        handleRateLimit(ptyTail);
        for (const ev of adapter.parseOutputChunk?.(stripAnsi(chunk)) ?? []) cb.onEvent(ev);
        const prompt = adapter.detectApprovalPrompt?.(ptyTail);
        if (prompt?.detected) {
          ptyTail = ''; // don't re-detect the same prompt on the next chunk
          cb.onApprovalPrompt({ actionSummary: prompt.actionSummary }, (decision) => {
            if (adapter.approvalInput) run.handle.write(adapter.approvalInput(decision));
          });
        }
        return;
      }
      emit(chunk, 'json_event');
      const data = partial[source] + chunk;
      const cut = data.lastIndexOf('\n');
      if (cut === -1) {
        partial[source] = data;
        return;
      }
      partial[source] = data.slice(cut + 1);
      onComplete(data.slice(0, cut));
    };

    let exited = false;
    const onExit = (exitCode: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      for (const source of ['stdout', 'stderr'] as const) {
        if (partial[source]) onComplete(partial[source]);
        partial[source] = '';
      }
      if (flushTimer) clearTimeout(flushTimer);
      if (logTimer) clearTimeout(logTimer);
      flushOut();
      flushLog();
      this.runs.delete(ctx.taskId);
      cb.onExit({ exitCode, signal, rateLimited: run.rateLimited, killed: run.killed });
    };

    // --- spawn -----------------------------------------------------------------------------------
    if (usePty) {
      ensurePtyHelperExecutable();
      const term = pty.spawn(command, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd: ctx.worktreePath, env });
      run.handle = {
        pid: term.pid,
        write: (d) => term.write(d),
        signal: (s) => signalGroup(term.pid, s, () => term.kill(s)),
      };
      term.onData((d) => onData(d, 'pty'));
      term.onExit(({ exitCode, signal }) => onExit(exitCode, signal ? String(signal) : null));
    } else {
      const child: ChildProcess = spawnChild(command, args, { cwd: ctx.worktreePath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      run.handle = {
        pid: child.pid ?? -1,
        write: (d) => child.stdin?.write(d),
        signal: (s) => signalGroup(child.pid, s, () => child.kill(s)),
      };
      child.stdout?.setEncoding('utf8').on('data', (d: string) => onData(d, 'stdout'));
      child.stderr?.setEncoding('utf8').on('data', (d: string) => onData(d, 'stderr'));
      child.stdin?.on('error', () => undefined); // agent closed stdin early
      child.on('error', (err) => {
        emit(`spawn error: ${err.message}\n`, 'json_event');
        onExit(127, null);
      });
      child.on('close', (code, signal) => onExit(code, signal));
    }

    this.runs.set(ctx.taskId, run);
    return run;
  }

  private terminate(run: ActiveRun): void {
    run.handle.signal('SIGTERM');
    const force = setTimeout(() => {
      if (this.runs.get(run.taskId) === run) run.handle.signal('SIGKILL');
    }, 5000);
    force.unref();
  }
}

/** Workers spawn their own children (shells, test runners); signal the whole process group. */
function signalGroup(pid: number | undefined, sig: NodeJS.Signals, fallback: () => void): void {
  if (pid && pid > 0) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* not a group leader / already gone */
    }
  }
  try {
    fallback();
  } catch {
    /* already exited */
  }
}
