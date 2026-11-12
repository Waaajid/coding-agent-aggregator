import { useState } from 'react';

export function TokenGate({ onToken, expired }: { onToken: (t: string) => void; expired: boolean }) {
  const [value, setValue] = useState('');
  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onToken(value.trim()); }} className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">Aggregator</h1>
        <p className="text-sm text-slate-400">
          {expired ? 'That token was rejected. ' : ''}Paste your admin token, or open the link printed by <code className="mono">npm run daemon</code>, which signs you in automatically.
        </p>
        <input autoFocus type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="contents of ~/.aggregator/secret.key" className="mono rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
        <button className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">Connect</button>
      </form>
    </div>
  );
}
