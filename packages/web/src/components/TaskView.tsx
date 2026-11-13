import { useState } from 'react';
import { duration } from '../lib/format';
import { useAppState, useStore } from '../lib/hooks';
import type { Nav } from '../lib/nav';
import type { MergeOutcome } from '../lib/types';
import { AgentBadge, Elapsed, StageTracker, StatusPill } from './bits';
import { DiffView } from './DiffView';
import { TerminalView } from './Terminal';

export function TaskView({ id, nav }: { id: string; nav: Nav }) {
  const store = useStore();
  const { tasks, approvals } = useAppState();
  const task = tasks[id];
  const [tab, setTab] = useState<'live' | 'changes'>('live');
  const [squash, setSquash] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  if (!task) return <div className="p-8 text-center text-slate-500">Task not found. <button className="underline" onClick={() => nav({ kind: 'overview' })}>Back to overview</button></div>;

  const pendingHere = approvals.filter((a) => a.taskId === id);
  const canMerge = task.status === 'completed';
  const canFeedback = ['completed', 'failed', 'rate_limited', 'cancelled'].includes(task.status);
  const active = ['queued', 'running', 'waiting_approval', 'verifying'].includes(task.status);

  const run = async (fn: () => Promise<unknown>, onDone?: (r: any) => void) => {
    setBusy(true);
    setNotice(null);
    try {
      onDone?.(await fn());
    } catch (e) {
      setNotice({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const doMerge = () =>
    run(() => store.merge(id, squash), (r: MergeOutcome) => {
      if (r.status === 'merged') setNotice({ tone: 'ok', text: `Merged as ${r.commit.slice(0, 8)}.` });
      else if (r.status === 'conflict') setNotice({ tone: 'error', text: `Merge conflict in: ${r.conflictedFiles.join(', ')}. Ask the worker to resolve it with “Request changes”.` });
      else if (r.status === 'target_dirty') setNotice({ tone: 'warn', text: `Your checked-out branch has local changes in the way: ${r.message}` });
    });

  const sendFeedback = () =>
    run(() => store.feedback(id, message.trim()), () => {
      setMessage('');
      setNotice({ tone: 'ok', text: 'Sent. The worker is resuming in the same worktree.' });
      setTab('live');
    });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-100">{task.title}</h2>
          <AgentBadge agent={task.agentId} />
          <StatusPill status={task.status} />
          <Elapsed task={task} />
          <span className="flex-1" />
          {active && <button disabled={busy} onClick={() => run(() => store.cancelTask(id))} className="rounded-lg border border-rose-500/50 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">Cancel</button>}
          {['failed', 'cancelled', 'rate_limited'].includes(task.status) && <button disabled={busy} onClick={() => run(() => store.retryTask(id))} className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50">Retry</button>}
        </div>
        <div className="mt-4 max-w-2xl"><StageTracker task={task} /></div>
        <p className="mono mt-3 truncate text-xs text-slate-500" title={task.worktreePath}>{task.branchName}</p>
        <details className="mt-2 text-sm text-slate-400">
          <summary className="cursor-pointer text-xs text-slate-500">Original instructions</summary>
          <p className="mt-2 whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-slate-300">{task.prompt}</p>
        </details>
        {task.verifyCommand && <p className="mt-2 text-xs text-slate-500">Verify: <code className="mono text-slate-300">{task.verifyCommand}</code></p>}
      </header>

      {task.errorMessage && <Banner tone="error">{task.errorMessage}</Banner>}
      {task.verifyOutput && task.status === 'failed' && <pre className="mono max-h-48 overflow-auto rounded-xl bg-black/40 p-3 text-xs text-rose-200">{task.verifyOutput}</pre>}
      {pendingHere.length > 0 && <Banner tone="warn">This worker is paused waiting for you. <button className="underline" onClick={() => nav({ kind: 'approvals' })}>Open the approval queue</button></Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      <div className="flex items-center gap-1 border-b border-slate-800">
        {(['live', 'changes'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === t ? 'border-indigo-400 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t === 'live' ? 'Live output' : 'Changes'}
          </button>
        ))}
        {task.startedAt && task.completedAt && <span className="ml-auto pr-2 text-xs text-slate-500">took {duration(task.completedAt - task.startedAt)}</span>}
      </div>

      {tab === 'live' ? <TerminalView key={task.id} task={task} /> : <DiffView task={task} />}

      {(canMerge || canFeedback) && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Review</h3>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Request changes — e.g. “also add a unit test”, “don’t touch the config file”…"
            rows={3}
            className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button disabled={busy || !message.trim() || !canFeedback} onClick={sendFeedback} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-40">Request changes</button>
            <span className="flex-1" />
            {canMerge && (
              <>
                <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} /> Squash</label>
                <button disabled={busy} onClick={doMerge} className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">{squash ? 'Squash & merge' : 'Merge'}</button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const c = tone === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  return <div className={`rounded-xl border px-4 py-3 text-sm ${c}`}>{children}</div>;
}
