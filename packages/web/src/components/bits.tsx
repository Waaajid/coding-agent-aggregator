import { STAGES, STATUS, stageIndex, taskElapsed } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { TaskRecord, TaskStatus } from '../lib/types';

export function StatusPill({ status }: { status: TaskStatus }) {
  const m = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${m.bg} ${m.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot} ${status === 'running' || status === 'verifying' ? 'animate-pulse' : ''}`} />
      {m.label}
    </span>
  );
}

const AGENT_COLORS: Record<string, string> = {
  claude: 'bg-orange-500/20 text-orange-300',
  codex: 'bg-emerald-500/20 text-emerald-300',
  antigravity: 'bg-fuchsia-500/20 text-fuchsia-300',
  gemini: 'bg-blue-500/20 text-blue-300',
};

export function AgentBadge({ agent }: { agent: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${AGENT_COLORS[agent] ?? 'bg-slate-500/20 text-slate-300'}`}>{agent}</span>;
}

/** Queued → Working → Verify → Review → Merged, with the current position and any blockage highlighted. */
export function StageTracker({ task, compact = false }: { task: Pick<TaskRecord, 'status' | 'verifyCommand'>; compact?: boolean }) {
  const { index, state } = stageIndex(task);
  const color = state === 'bad' ? 'bg-rose-400' : state === 'attention' ? 'bg-amber-400' : state === 'done' ? 'bg-teal-400' : 'bg-sky-400';
  return (
    <ol className="flex items-center gap-1" aria-label="progress">
      {STAGES.map((label, i) => {
        const skipped = label === 'Verify' && !task.verifyCommand;
        const reached = i < index || (i === index && state !== 'bad') || (state === 'done' && i <= index);
        const current = i === index;
        return (
          <li key={label} className="flex flex-1 flex-col gap-1" title={skipped ? 'Verify (not configured)' : label}>
            <span
              className={`h-1.5 rounded-full ${skipped ? 'bg-slate-800' : reached ? (current ? color : 'bg-slate-500') : current && state === 'bad' ? 'bg-rose-400' : 'bg-slate-700'} ${current && state === 'attention' ? 'pulse-amber' : ''}`}
            />
            {!compact && <span className={`text-[10px] ${current ? 'text-slate-200' : 'text-slate-500'}`}>{label}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function Elapsed({ task }: { task: TaskRecord }) {
  const now = useNow(1000);
  const live = !task.completedAt && !!task.startedAt;
  return <span className="mono text-xs text-slate-400">{live ? taskElapsed(task, now) : taskElapsed(task)}</span>;
}
