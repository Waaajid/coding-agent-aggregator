import { html } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/hooks';
import type { DiffResponse, TaskRecord } from '../lib/types';

export function DiffView({ task }: { task: TaskRecord }) {
  const store = useStore();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sideBySide, setSideBySide] = useState(() => window.innerWidth > 1100);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await store.api.request<DiffResponse>('GET', `/api/tasks/${task.id}/diff?maxLines=5000`));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [store, task.id]);

  // Reload whenever the task changes state (a finished worker has new changes).
  useEffect(() => {
    if (task.status !== 'merged') void load();
  }, [load, task.status, task.completedAt]);

  const rendered = useMemo(
    () =>
      data?.diff
        ? html(data.diff, { drawFileList: true, matching: 'lines', outputFormat: sideBySide ? 'side-by-side' : 'line-by-line', colorScheme: ColorSchemeType.DARK })
        : '',
    [data, sideBySide],
  );

  if (task.status === 'merged') return <Empty>This task was merged and its worktree has been cleaned up.</Empty>;
  if (error) return <Empty tone="error">{error}</Empty>;
  if (!data) return <Empty>{loading ? 'Loading changes…' : 'No data'}</Empty>;

  const added = data.files.reduce((n, f) => n + f.added, 0);
  const deleted = data.files.reduce((n, f) => n + f.deleted, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span>
          <b className="text-slate-200">{data.files.length}</b> files · <span className="text-emerald-400">+{added}</span> <span className="text-rose-400">−{deleted}</span>
        </span>
        <span className="mono truncate">{data.branch} → {data.base_branch}</span>
        <span className="flex-1" />
        <button onClick={() => setSideBySide((v) => !v)} className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800">{sideBySide ? 'Unified' : 'Side by side'}</button>
        <button onClick={() => void load()} className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800">{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {data.truncated && <p className="text-xs text-amber-300">Diff truncated to the first lines ({data.total_lines} total).</p>}
      {rendered ? <div className="overflow-x-auto rounded-xl border border-slate-800" dangerouslySetInnerHTML={{ __html: rendered }} /> : <Empty>No changes yet.</Empty>}
    </div>
  );
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className={`rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm ${tone === 'error' ? 'text-rose-300' : 'text-slate-500'}`}>{children}</div>;
}
