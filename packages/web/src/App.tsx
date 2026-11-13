import { useEffect, useMemo, useState } from 'react';
import { Approvals } from './components/Approvals';
import { Elapsed, StatusPill, AgentBadge } from './components/bits';
import { ChatView } from './components/Chat';
import { NewTask } from './components/NewTask';
import { Overview } from './components/Overview';
import { TaskView } from './components/TaskView';
import { TokenGate } from './components/TokenGate';
import { useAppState, StoreContext, useNow } from './lib/hooks';
import type { Nav, View } from './lib/nav';
import { Store } from './lib/store';
import { STATUS } from './lib/format';

const TOKEN_KEY = 'agg.token';

function readToken(): string | null {
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]!));
    history.replaceState(null, '', location.pathname + location.search); // never leave the token in the URL
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function App() {
  const [token, setToken] = useState(readToken);
  const [expired, setExpired] = useState(false);
  const store = useMemo(
    () =>
      token
        ? new Store(token, () => {
            localStorage.removeItem(TOKEN_KEY);
            setExpired(true);
            setToken(null);
          })
        : null,
    [token],
  );
  useEffect(() => () => store?.dispose(), [store]);
  useEffect(() => {
    const onHash = () => {
      const t = readToken();
      if (t) {
        setExpired(false);
        setToken(t);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!store) return <TokenGate expired={expired} onToken={(t) => { localStorage.setItem(TOKEN_KEY, t); setExpired(false); setToken(t); }} />;
  return (
    <StoreContext.Provider value={store}>
      <Shell />
    </StoreContext.Provider>
  );
}

function Shell() {
  const { conn, approvals, agents, chats } = useAppState();
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [newTask, setNewTask] = useState(false);
  const [notif, setNotif] = useState<NotificationPermission | 'unsupported'>('Notification' in window ? Notification.permission : 'unsupported');
  const nav: Nav = (v) => setView(v);
  const pending = approvals.length;

  useEffect(() => {
    document.title = pending ? `(${pending}) Approval needed · Aggregator` : 'Aggregator';
  }, [pending]);

  const busyChat = chats.some((c) => c.busy);

  const navItems: Array<{ key: string; label: string; icon: string; view: View; active: boolean }> = [
    { key: 'overview', label: 'Overview', icon: '◎', view: { kind: 'overview' }, active: view.kind === 'overview' },
    { key: 'approvals', label: 'Approvals', icon: '✋', view: { kind: 'approvals' }, active: view.kind === 'approvals' },
    { key: 'chat', label: 'Manager', icon: '💬', view: { kind: 'chat' }, active: view.kind === 'chat' },
    { key: 'tasks', label: 'Tasks', icon: '☰', view: { kind: 'tasks' }, active: view.kind === 'tasks' || view.kind === 'task' },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-950/80 px-4 py-2.5 backdrop-blur">
        <button onClick={() => nav({ kind: 'overview' })} className="text-base font-semibold tracking-tight">⛓ Aggregator</button>
        <span className={`flex items-center gap-1.5 text-xs ${conn === 'open' ? 'text-emerald-400' : 'text-amber-400'}`} title={`WebSocket ${conn}`}>
          <span className={`h-2 w-2 rounded-full ${conn === 'open' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          <span className="hidden sm:inline">{conn === 'open' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
        </span>
        <span className="flex-1" />
        <div className="hidden items-center gap-1.5 md:flex">
          {agents.map((a) => {
            const limited = a.rateLimitedUntil && a.rateLimitedUntil > Date.now();
            return (
              <span key={a.id} title={`${a.displayName}: ${!a.installed ? 'not installed' : limited ? 'rate limited' : `ready${a.version ? ` (${a.version})` : ''}`}`} className="flex items-center gap-1.5 rounded-full border border-slate-800 px-2 py-0.5 text-xs text-slate-300">
                <span className={`h-1.5 w-1.5 rounded-full ${!a.installed ? 'bg-slate-600' : limited ? 'bg-orange-400' : 'bg-emerald-400'}`} />
                {a.id}
              </span>
            );
          })}
        </div>
        {notif === 'default' && <button onClick={() => void Notification.requestPermission().then(setNotif)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800" title="Get a desktop notification when a worker needs approval">🔔 Alerts</button>}
        <button onClick={() => setNewTask(true)} className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400">+ Task</button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950/40 lg:flex">
          <nav className="flex flex-col gap-1 p-3">
            {navItems.filter((i) => i.key !== 'tasks').map((i) => (
              <button key={i.key} onClick={() => nav(i.view)} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${i.active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                <span className="w-5 text-center">{i.icon}</span>
                <span className="flex-1">{i.label}</span>
                {i.key === 'approvals' && pending > 0 && <span className="rounded-full bg-amber-400 px-2 text-xs font-bold text-amber-950 pulse-amber">{pending}</span>}
                {i.key === 'chat' && busyChat && <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" title="manager is working" />}
              </button>
            ))}
          </nav>
          <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Tasks</div>
          <TaskList nav={nav} selected={view.kind === 'task' ? view.id : undefined} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">
          {view.kind === 'overview' && <Overview nav={nav} onNewTask={() => setNewTask(true)} />}
          {view.kind === 'approvals' && <Approvals nav={nav} />}
          {view.kind === 'task' && <TaskView key={view.id} id={view.id} nav={nav} />}
          {view.kind === 'tasks' && <div className="lg:hidden"><TaskList nav={nav} /></div>}
          {view.kind === 'tasks' && <div className="hidden p-8 text-center text-sm text-slate-500 lg:block">Pick a task from the sidebar.</div>}
          {view.kind === 'chat' && <div className="h-[calc(100dvh-3.25rem-4rem)] lg:h-[calc(100dvh-3.25rem)]"><ChatView chatId={view.chatId} onSelect={(id) => nav({ kind: 'chat', chatId: id })} /></div>}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {navItems.map((i) => (
          <button key={i.key} onClick={() => nav(i.view)} className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${i.active ? 'text-white' : 'text-slate-500'}`}>
            <span className="text-lg leading-none">{i.icon}</span>
            {i.label}
            {i.key === 'approvals' && pending > 0 && <span className="absolute right-[28%] top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-amber-950">{pending}</span>}
          </button>
        ))}
      </nav>

      {newTask && <NewTask nav={nav} onClose={() => setNewTask(false)} />}
    </div>
  );
}

function TaskList({ nav, selected }: { nav: Nav; selected?: string }) {
  const { tasks } = useAppState();
  useNow(5000);
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  if (list.length === 0) return <p className="px-4 py-6 text-center text-xs text-slate-600">No tasks yet</p>;
  return (
    <ul className="flex-1 overflow-y-auto px-2 pb-3">
      {list.map((t) => (
        <li key={t.id}>
          <button onClick={() => nav({ kind: 'task', id: t.id })} className={`flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left ${selected === t.id ? 'bg-slate-800' : 'hover:bg-slate-900'}`}>
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[t.status].dot} ${t.status === 'waiting_approval' ? 'pulse-amber' : ''}`} />
              <span className="flex-1 truncate text-sm text-slate-200">{t.title}</span>
              <AgentBadge agent={t.agentId} />
            </span>
            <span className="flex items-center justify-between pl-4">
              <StatusPill status={t.status} />
              <Elapsed task={t} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
