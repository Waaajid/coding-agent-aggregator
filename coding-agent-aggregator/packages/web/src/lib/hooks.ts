import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { State, Store } from './store';

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreContext missing');
  return s;
}

export function useAppState(): State {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Re-renders every `ms` so elapsed timers stay live. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function useLocalStorage(key: string, fallback = ''): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback);
  return [
    value,
    (v: string) => {
      localStorage.setItem(key, v);
      setValue(v);
    },
  ];
}
