import { useState } from 'react';
import { ago } from '../lib/format';
import { useAppState, useNow, useStore } from '../lib/hooks';
import type { Nav } from '../lib/nav';
import type { ApprovalRecord } from '../lib/types';
import { AgentBadge } from './bits';

function ApprovalCard({ a, nav }: { a: ApprovalRecord; nav: Nav }) {
  const store = useStore();
  const { tasks } = useAppState();
  const now = useNow(5000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const task = tasks[a.taskId];
  const isMerge = a.toolName === 'merge_worktree';

  const act = async (decision: 'approve' | 'deny', remember = false) => {
    setBusy(true);
    setError('');
    try {
      await store.resolveApproval(a.id, decision, remember);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
        <span className="flex items-center gap-2">
          <AgentBadge agent={a.agentId} />
          <button className="max-w-[40vw] truncate text-slate-300 underline-offset-2 hover:underline" onClick={() => nav({ kind: 'task', id: a.taskId })}>
            {task?.title ?? a.taskId}
          </button>
        </span>
        <span>{ago(a.createdAt, now)}</span>
      </div>
      <div className="mb-1 text-sm font-semibold text-amber-200">{isMerge ? 'Manager wants to merge' : `Wants to run: ${a.toolName}`}</div>
      <pre className="mono mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-2.5 text-xs text-slate-200">{a.summary}</pre>
      {error && <p className="mb-2 text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => act('approve')} className="flex-1 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">
          {isMerge ? 'Approve merge' : 'Approve'}
        </button>
        <button disabled={busy} onClick={() => act('deny')} className="flex-1 rounded-lg bg-rose-500/90 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-50">
          Deny
        </button>
      </div>
      {!isMerge && (
        <button disabled={busy} onClick={() => act('approve', true)} className="mt-2 w-full text-center text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50">
          Approve and don’t ask again for this task
        </button>
      )}
    </div>
  );
}

export function Approvals({ nav }: { nav: Nav }) {
  const { approvals } = useAppState();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Approval queue</h2>
      {approvals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">Nothing is waiting for you. Workers that need permission will show up here instantly.</div>
      ) : (
        approvals.map((a) => <ApprovalCard key={a.id} a={a} nav={nav} />)
      )}
    </div>
  );
}
