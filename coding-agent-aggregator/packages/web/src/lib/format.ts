import type { TaskRecord, TaskStatus } from './types';

export const STATUS: Record<TaskStatus, { label: string; text: string; bg: string; dot: string }> = {
  queued: { label: 'Queued', text: 'text-slate-300', bg: 'bg-slate-500/15', dot: 'bg-slate-400' },
  running: { label: 'Running', text: 'text-sky-300', bg: 'bg-sky-500/15', dot: 'bg-sky-400' },
  waiting_approval: { label: 'Needs you', text: 'text-amber-300', bg: 'bg-amber-500/15', dot: 'bg-amber-400' },
  verifying: { label: 'Verifying', text: 'text-violet-300', bg: 'bg-violet-500/15', dot: 'bg-violet-400' },
  completed: { label: 'Ready to review', text: 'text-emerald-300', bg: 'bg-emerald-500/15', dot: 'bg-emerald-400' },
  failed: { label: 'Failed', text: 'text-rose-300', bg: 'bg-rose-500/15', dot: 'bg-rose-400' },
  rate_limited: { label: 'Rate limited', text: 'text-orange-300', bg: 'bg-orange-500/15', dot: 'bg-orange-400' },
  cancelled: { label: 'Cancelled', text: 'text-slate-400', bg: 'bg-slate-500/15', dot: 'bg-slate-500' },
  merged: { label: 'Merged', text: 'text-teal-300', bg: 'bg-teal-500/15', dot: 'bg-teal-400' },
};

export const isWorking = (s: TaskStatus) => ['queued', 'running', 'waiting_approval', 'verifying'].includes(s);
export const isProblem = (s: TaskStatus) => ['failed', 'rate_limited'].includes(s);

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function taskElapsed(t: TaskRecord, now = Date.now()): string | null {
  if (!t.startedAt) return null;
  return duration((t.completedAt ?? now) - t.startedAt);
}

/** Pipeline shown on every task: where is it, and what comes next. */
export const STAGES = ['Queued', 'Working', 'Verify', 'Review', 'Merged'] as const;
export function stageIndex(t: Pick<TaskRecord, 'status' | 'verifyCommand'>): { index: number; state: 'active' | 'attention' | 'bad' | 'done' } {
  switch (t.status) {
    case 'queued': return { index: 0, state: 'active' };
    case 'running': return { index: 1, state: 'active' };
    case 'waiting_approval': return { index: 1, state: 'attention' };
    case 'verifying': return { index: 2, state: 'active' };
    case 'completed': return { index: 3, state: 'attention' };
    case 'merged': return { index: 4, state: 'done' };
    case 'failed':
    case 'rate_limited': return { index: 1, state: 'bad' };
    default: return { index: 0, state: 'bad' };
  }
}

// ---- agent output prettifier ---------------------------------------------------------------------------------
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

function clip(s: string, n = 220): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function formatEvent(obj: Record<string, any>): string | null {
  if (obj.type === 'system') return `${DIM}— session ${obj.session_id ?? ''} started${RESET}`;
  if (obj.type === 'assistant') {
    const out: string[] = [];
    for (const b of obj.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) out.push(b.text.trim());
      if (b.type === 'tool_use') {
        const input = b.input ?? {};
        const detail = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
        out.push(`${CYAN}▸ ${b.name}${RESET} ${DIM}${clip(String(detail), 160)}${RESET}`);
      }
    }
    return out.length ? out.join('\n') : null;
  }
  if (obj.type === 'user') return null; // tool results are noisy
  if (obj.type === 'result') return obj.is_error ? `${RED}✗ ${clip(String(obj.result ?? 'error'))}${RESET}` : `${GREEN}✓ finished${RESET}`;
  const msg = obj.msg ?? obj; // Codex events
  if (typeof msg.type === 'string' && typeof msg.message === 'string') return msg.type.includes('error') ? `${RED}${msg.message}${RESET}` : msg.message;
  return `${DIM}${clip(JSON.stringify(obj), 160)}${RESET}`;
}

/**
 * Turns a headless agent's JSON-lines stream into readable terminal text. PTY output (not JSON) is passed
 * through untouched; the mode is decided from the first non-empty chunk.
 */
export class StreamFormatter {
  private mode: 'unknown' | 'jsonl' | 'raw' = 'unknown';
  private partial = '';

  reset(): void {
    this.mode = 'unknown';
    this.partial = '';
  }

  push(chunk: string): string {
    if (this.mode === 'unknown') {
      const first = chunk.trimStart();
      if (!first) return chunk;
      this.mode = first.startsWith('{') ? 'jsonl' : 'raw';
    }
    if (this.mode === 'raw') return chunk;

    const data = this.partial + chunk;
    const lines = data.split('\n');
    this.partial = lines.pop() ?? '';
    let out = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('{')) {
        try {
          const f = formatEvent(JSON.parse(t));
          if (f) out += `${f.replace(/\n/g, '\r\n')}\r\n`;
          continue;
        } catch {
          /* not JSON after all: show as text */
        }
      }
      out += `${t}\r\n`;
    }
    return out;
  }
}
