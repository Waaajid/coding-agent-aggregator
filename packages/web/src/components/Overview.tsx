import { ago, isProblem, isWorking, STATUS } from '../lib/format';
import { useAppState, useNow } from '../lib/hooks';
import type { Nav } from '../lib/nav';
import type { TaskRecord } from '../lib/types';
import { AgentBadge, Elapsed, StageTracker } from './bits';

function Stat({ label, value, tone, onClick }: { label: string; value: number; tone: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex-1 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left transition hover:border-slate-700">
      <div className={`text-2xl font-semibold ${value ? tone : 'text-slate-600'}`}>{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </button>
  );
}

function TaskCard({ task, nav }: { task: TaskRecord; nav: Nav }) {
  const waiting = task.status === 'waiting_approval';
  return (
    <button
      onClick={() => nav({ kind: 'task', id: task.id })}
      className={`w-full rounded-xl border bg-slate-900/70 p-3 text-left transition hover:bg-slate-900 ${waiting ? 'border-amber-500/60' : 'border-slate-800 hover:border-slate-700'}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-slate-100">{task.title}</span>
        <AgentBadge agent={task.agentId} />
      </div>
      <StageTracker task={task} />
      <div className="mt-2 flex items-center justify-between">
        <span className={`text-xs ${STATUS[task.status].text}`}>{STATUS[task.status].label}</span>
        <Elapsed task={task} />
      </div>
      {task.errorMessage && <p className="mt-2 line-clamp-2 text-xs text-rose-300/90">{task.errorMessage}</p>}
    </button>
  );
}

function Column({ title, hint, tasks, nav, empty }: { title: string; hint: string; tasks: TaskRecord[]; nav: Nav; empty: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <header className="flex items-baseline justify-between px-1">
        <h3 className="text-sm font-semibold text-slate-200">
          {title} <span className="ml-1 text-xs font-normal text-slate-500">{tasks.length}</span>
        </h3>
        <span className="hidden text-[11px] text-slate-500 xl:block">{hint}</span>
      </header>
      <div className="flex flex-col gap-2">
        {tasks.length === 0 ? <div className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-xs text-slate-600">{empty}</div> : tasks.map((t) => <TaskCard key={t.id} task={t} nav={nav} />)}
      </div>
    </section>
  );
}

const DOT: Record<string, string> = { info: 'bg-sky-400', success: 'bg-emerald-400', warn: 'bg-amber-400', error: 'bg-rose-400', approval: 'bg-amber-400' };

export function Overview({ nav, onNewTask }: { nav: Nav; onNewTask: () => void }) {
  const { tasks, approvals, activity, agents } = useAppState();
  const now = useNow(5000);
  const all = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  const working = all.filter((t) => isWorking(t.status));
  const review = all.filter((t) => t.status === 'completed');
  const problems = all.filter((t) => isProblem(t.status) || t.status === 'cancelled');
  const merged = all.filter((t) => t.status === 'merged');
  const installed = agents.filter((a) => a.installed).length;

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
      {all.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center">
          <h2 className="text-lg font-semibold text-slate-100">Nothing running yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            Ask the manager to plan and delegate work for you, or start a worker task directly. Every task runs in its own git worktree, so nothing touches your
            checkout until you merge.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={() => nav({ kind: 'chat' })} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">Chat with the manager</button>
            <button onClick={onNewTask} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">New task</button>
          </div>
          <p className="mt-4 text-xs text-slate-500">{installed} of {agents.length} agent CLIs detected on this machine.</p>
        </div>
      ) : (
        <>
          <div className="flex gap-3">
            <Stat label="Working" value={working.length} tone="text-sky-300" />
            <Stat label="Needs your approval" value={approvals.length} tone="text-amber-300" onClick={() => nav({ kind: 'approvals' })} />
            <Stat label="Ready to review" value={review.length} tone="text-emerald-300" />
            <Stat label="Needs attention" value={problems.length} tone="text-rose-300" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
              <Column title="Working" hint="agents are on it" tasks={working} nav={nav} empty="No active workers" />
              <Column title="Ready to review" hint="check the diff, then merge" tasks={review} nav={nav} empty="Nothing waiting" />
              <Column title="Needs attention" hint="failed, limited or cancelled" tasks={problems} nav={nav} empty="All clear" />
              <Column title="Merged" hint="landed on your branch" tasks={merged} nav={nav} empty="Nothing merged yet" />
            </div>
            <ActivityFeed items={activity} now={now} nav={nav} />
          </div>
        </>
      )}
      {all.length === 0 && <ActivityFeed items={activity} now={now} nav={nav} />}
    </div>
  );
}

function ActivityFeed({ items, now, nav }: { items: ReturnType<typeof useAppState>['activity']; now: number; nav: Nav }) {
  if (items.length === 0) return null;
  return (
    <aside className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Live activity</h3>
      <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
        {items.map((a) => (
          <li key={a.id}>
            <button disabled={!a.taskId} onClick={() => a.taskId && nav({ kind: 'task', id: a.taskId })} className="flex w-full items-start gap-2 text-left text-xs enabled:hover:text-white">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[a.kind]}`} />
              <span className="flex-1 text-slate-300">{a.text}</span>
              <span className="shrink-0 text-slate-600">{ago(a.at, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
