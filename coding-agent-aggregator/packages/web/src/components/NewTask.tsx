import { useState } from 'react';
import { useAppState, useLocalStorage, useStore } from '../lib/hooks';
import type { Nav } from '../lib/nav';

const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400';

export function NewTask({ onClose, nav }: { onClose: () => void; nav: Nav }) {
  const store = useStore();
  const { agents } = useAppState();
  const [repo, setRepo] = useLocalStorage('agg.repo');
  const [agent, setAgent] = useState(agents.find((a) => a.installed)?.id ?? 'claude');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [policy, setPolicy] = useState('ask_shell');
  const [verify, setVerify] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createdId, setCreatedId] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { task, warnings } = await store.createTask({
        repoPath: repo.trim(), agent, title: title.trim(), prompt: prompt.trim(), baseBranch: baseBranch.trim() || 'main',
        approvalPolicy: policy, ...(verify.trim() ? { verifyCommand: verify.trim() } : {}),
      });
      if (warnings.length) {
        setWarnings(warnings);
        setCreatedId(task.id);
      } else {
        onClose();
        nav({ kind: 'task', id: task.id });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="flex max-h-[92vh] w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-900 p-5 sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New worker task</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close">✕</button>
        </div>

        {createdId ? (
          <>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{warnings.map((w) => <p key={w}>{w}</p>)}</div>
            <button type="button" onClick={() => { onClose(); nav({ kind: 'task', id: createdId }); }} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white">Open task</button>
          </>
        ) : (
          <>
            <label className="text-xs text-slate-400">Project folder (a git repository)<input required className={`${field} mono mt-1`} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/Users/you/projects/my-app" />
              <span className="mt-1 block text-[11px] text-slate-500">Full path of a folder that contains <code>.git</code>. Tip: run <code>pwd</code> in a terminal inside your project.</span></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Agent
                <select className={`${field} mt-1`} value={agent} onChange={(e) => setAgent(e.target.value)}>
                  {agents.map((a) => <option key={a.id} value={a.id} disabled={!a.installed}>{a.displayName}{a.installed ? '' : ' (not installed)'}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-400">Base branch<input className={`${field} mono mt-1`} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} /></label>
            </div>
            <label className="text-xs text-slate-400">Title<input required maxLength={80} className={`${field} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="add-login-form" /></label>
            <label className="text-xs text-slate-400">Instructions<textarea required rows={5} className={`${field} mt-1`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Detailed task: what to build, which files, acceptance criteria…" /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Approvals
                <select className={`${field} mt-1`} value={policy} onChange={(e) => setPolicy(e.target.value)}>
                  <option value="ask_shell">Ask before shell commands</option>
                  <option value="ask_all">Ask before everything</option>
                  <option value="auto_edit">Auto-approve edits &amp; safe commands</option>
                </select>
              </label>
              <label className="text-xs text-slate-400">Verify command<input className={`${field} mono mt-1`} value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" /></label>
            </div>
            {error && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>}
            <button disabled={busy} className="rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-50">{busy ? 'Creating worktree…' : 'Start task'}</button>
          </>
        )}
      </form>
    </div>
  );
}
