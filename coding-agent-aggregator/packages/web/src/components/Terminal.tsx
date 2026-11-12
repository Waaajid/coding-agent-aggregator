import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { StreamFormatter } from '../lib/format';
import { useAppState, useStore } from '../lib/hooks';
import type { TaskRecord } from '../lib/types';

/** Live terminal for one task: replays the buffer, then follows pty.data; typing is forwarded to PTY agents. */
export function TerminalView({ task }: { task: TaskRecord }) {
  const store = useStore();
  const host = useRef<HTMLDivElement>(null);
  const taskId = task.id;
  const { conn } = useAppState(); // a reconnect rebuilds the terminal so the stream is re-subscribed

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 10_000,
      convertEol: true, // headless agents print bare \n
      cursorBlink: true,
      theme: { background: '#05070d', foreground: '#d6dbe6', cursor: '#818cf8', selectionBackground: '#334155' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(el);

    const fmt = new StreamFormatter();
    let lastSeq = 0;
    let ready = false;
    const queued: Array<{ chunk: string; seq: number }> = [];
    const write = (chunk: string) => term.write(fmt.push(chunk));

    const offPush = store.ws.on('pty.data', (p: { taskId: string; chunk: string; seq: number }) => {
      if (p.taskId !== taskId) return;
      if (!ready) queued.push(p);
      else if (p.seq > lastSeq) {
        lastSeq = p.seq;
        write(p.chunk);
      }
    });

    let cancelled = false;
    const subscribe = () =>
      store.ws
        .rpc<{ buffer: string; seq: number }>('task.subscribe', { taskId })
        .then(({ buffer, seq }) => {
          if (cancelled) return;
          term.reset();
          fmt.reset();
          if (buffer) write(buffer);
          lastSeq = seq;
          ready = true;
          for (const p of queued.splice(0)) if (p.seq > lastSeq) { lastSeq = p.seq; write(p.chunk); }
        })
        .catch(() => term.write('\x1b[2m(waiting for connection…)\x1b[0m\r\n'));
    void subscribe();

    const input = term.onData((data) => void store.ws.rpc('task.sendInput', { taskId, data }).catch(() => undefined));

    return () => {
      cancelled = true;
      offPush();
      input.dispose();
      ro.disconnect();
      void store.ws.rpc('task.unsubscribe', { taskId }).catch(() => undefined);
      term.dispose();
    };
  }, [store, taskId, conn]);

  return <div ref={host} className="h-[52vh] min-h-[260px] overflow-hidden rounded-xl border border-slate-800 bg-[#05070d]" />;
}
