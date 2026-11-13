import { useEffect, useRef, useState } from 'react';
import { ago } from '../lib/format';
import { useAppState, useLocalStorage, useNow, useStore } from '../lib/hooks';
import type { ChatMessage } from '../lib/types';

const SUGGESTIONS = [
  'Which worker agents are installed and healthy?',
  'Review the repo and propose a plan: split it into 2–3 independent tasks, then delegate them.',
  'What is the status of all running tasks?',
];

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'tool') {
    const space = m.content.indexOf(' ');
    const name = space < 0 ? m.content : m.content.slice(0, space);
    const args = space < 0 ? '' : m.content.slice(space + 1);
    return (
      <details className="mono self-start rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-400">
        <summary className="cursor-pointer select-none"><span className="text-cyan-300">{name}</span> <span className="text-slate-600">{args.length > 70 ? `${args.slice(0, 70)}…` : args}</span></summary>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-slate-300">{args}</pre>
      </details>
    );
  }
  if (m.role === 'system') return <div className="self-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 whitespace-pre-wrap">{m.content}</div>;
  const mine = m.role === 'user';
  return (
    <div className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${mine ? 'self-end bg-indigo-500 text-white' : 'self-start border border-slate-800 bg-slate-900 text-slate-100'}`}>
      {m.content}
    </div>
  );
}

export function ChatView({ chatId, onSelect }: { chatId?: string; onSelect: (id: string) => void }) {
  const store = useStore();
  const { chats, messages } = useAppState();
  const now = useNow(15000);
  const [repo, setRepo] = useLocalStorage('agg.repo');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const chat = chats.find((c) => c.id === chatId) ?? (chatId ? undefined : chats[0]);
  const list = chat ? (messages[chat.id] ?? []) : [];

  useEffect(() => {
    if (chat) void store.loadMessages(chat.id);
  }, [store, chat?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [list.length, chat?.busy]);

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      onSelect((await store.createChat(repo.trim())).id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const send = async (message = text) => {
    if (!chat || !message.trim() || chat.busy) return;
    setText('');
    setError('');
    try {
      await store.sendChat(chat.id, message.trim());
    } catch (e) {
      setError((e as Error).message);
      setText(message);
    }
  };

  const newChatForm = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/absolute/path/to/your/git/repo" className="mono flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
      <button disabled={starting || !repo.trim()} onClick={start} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50">{starting ? 'Starting…' : 'Start chat'}</button>
    </div>
  );

  if (!chat) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">Chat with the manager</h2>
        <p className="text-sm text-slate-400">
          The manager is an AI project lead. You tell it a goal; it splits the work into small jobs, hands them to worker agents, checks their results and asks you
          before anything is merged.
        </p>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
          <p className="mb-2 font-medium text-slate-100">First: which project should it work on?</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-400">
            <li>Paste the <b className="text-slate-200">full path</b> of a folder that is a <b className="text-slate-200">git project</b> (it contains a hidden <code className="mono">.git</code> folder and at least one commit).</li>
            <li>Example: <code className="mono text-slate-300">/Users/you/projects/my-app</code></li>
            <li>Easy way: open a terminal, <code className="mono">cd</code> into your project, run <code className="mono">pwd</code>, and paste the result here.</li>
            <li>Your files are never changed directly. Workers use private copies, and nothing lands in your project until you click <b className="text-slate-200">Merge</b>.</li>
          </ul>
        </div>
        {newChatForm}
        {error && <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
        <select value={chat.id} onChange={(e) => onSelect(e.target.value)} className="max-w-[55%] truncate rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm">
          {chats.map((c) => <option key={c.id} value={c.id}>{c.title} · {ago(c.createdAt, now)}</option>)}
          <option value="__new">+ New chat…</option>
        </select>
        <span className="mono truncate text-xs text-slate-500" title={chat.repoPath}>{chat.repoPath}</span>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {list.length === 0 && (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-sm text-slate-400">Describe what you want built. Try one of these:</p>
            {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-left text-sm text-slate-300 hover:border-indigo-400/60">{s}</button>)}
          </div>
        )}
        {list.map((m) => <Message key={m.id} m={m} />)}
        {chat.busy && (
          <div className="dot-typing flex items-center gap-1 self-start rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-slate-400"><span>●</span><span>●</span><span>●</span></div>
        )}
        <div ref={bottom} />
      </div>

      {error && <p className="px-4 pb-1 text-xs text-rose-300">{error}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex items-end gap-2 border-t border-slate-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          rows={2}
          placeholder={chat.busy ? 'The manager is working…' : 'Message the manager (Enter to send, Shift+Enter for a new line)'}
          className="max-h-40 flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm outline-none placeholder:text-slate-600 focus:border-indigo-400"
        />
        {chat.busy ? (
          <button type="button" onClick={() => void store.cancelChat(chat.id)} className="rounded-xl border border-rose-500/60 px-4 py-3 text-sm text-rose-300 hover:bg-rose-500/10">Stop</button>
        ) : (
          <button type="submit" disabled={!text.trim()} className="rounded-xl bg-indigo-500 px-5 py-3 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-40">Send</button>
        )}
      </form>
    </div>
  );
}
