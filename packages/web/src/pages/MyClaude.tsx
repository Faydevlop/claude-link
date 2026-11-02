import { useEffect, useRef, useState } from 'react';
import { desktop, type MyClaudeSession } from '../desktop.ts';
import { useStore } from '../store.tsx';
import { Button, cx, Empty, inputCls } from '../ui.tsx';

const SUGGESTIONS = [
  'What is everyone on the team working on?',
  'Ask the backend Claude what the /orders API returns',
  'Report status: working on the login page',
  'Explain the folder structure of my project',
];

export default function MyClaude({ repoPath }: { repoPath: string | null }) {
  const bridge = desktop!;
  const { me } = useStore();
  const [sessions, setSessions] = useState<MyClaudeSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'ask' | 'edit'>('ask');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const active = sessions.find(s => s.id === activeId) ?? null;

  useEffect(() => {
    void bridge.myClaude.list().then(setSessions);
    return bridge.onEvent(e => {
      if (e.type !== 'myClaude') return;
      setSessions(list => {
        const rest = list.filter(s => s.id !== e.session.id);
        return [e.session, ...rest];
      });
    });
  }, [bridge]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [active?.messages.length, active?.messages.at(-1)?.text.length, active?.messages.at(-1)?.tools.length]);
  useEffect(() => { if (active) setMode(active.mode); }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (msg = text) => {
    if (!msg.trim()) return;
    setError('');
    try {
      const s = await bridge.myClaude.send({ sessionId: activeId, text: msg.trim(), mode });
      setSessions(list => [s, ...list.filter(x => x.id !== s.id)]);
      setActiveId(s.id);
      setText('');
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-stone-200 bg-stone-100/60 max-md:hidden dark:border-stone-800 dark:bg-stone-900/40">
        <div className="p-3"><Button kind="primary" className="w-full" onClick={() => { setActiveId(null); setText(''); }}>+ New chat</Button></div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map(s => (
            <div key={s.id} className={cx('group flex items-center gap-1 rounded-lg', activeId === s.id ? 'bg-brand/10' : 'hover:bg-stone-200/60 dark:hover:bg-stone-800')}>
              <button className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm" onClick={() => setActiveId(s.id)}>
                {s.running && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-brand align-middle" />}{s.title}
              </button>
              <button className="px-2 text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-600" title="Delete"
                onClick={async () => { await bridge.myClaude.remove(s.id); setSessions(l => l.filter(x => x.id !== s.id)); if (activeId === s.id) setActiveId(null); }}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          <div className="min-w-0">
            <div className="font-semibold">My Claude</div>
            <div className="truncate text-xs text-stone-500">{repoPath ? `Working in ${repoPath}` : 'No project folder set (Settings → Project folder)'}</div>
          </div>
          <div className="ml-auto flex rounded-lg bg-stone-200/70 p-0.5 text-sm dark:bg-stone-800">
            {(['ask', 'edit'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} title={m === 'ask' ? 'Read-only: Claude can look but not change anything' : 'Claude can edit files and run commands in your project'}
                className={cx('rounded-md px-3 py-1', mode === m && 'bg-white shadow-sm dark:bg-stone-950')}>
                {m === 'ask' ? 'Ask (read-only)' : 'Edit'}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4">
          {!active ? (
            <div className="mx-auto max-w-xl py-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-brand text-2xl text-white">✳︎</div>
              <h2 className="mt-4 text-lg font-semibold">Hi {me.name}, what can I help with?</h2>
              <p className="mt-1 text-sm text-stone-500">This is your own Claude Code, connected to your team. Ask about your code, or ask it to talk to a teammate's Claude.</p>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => void send(s)} className="rounded-xl border border-stone-200 bg-white p-3 text-left text-sm hover:border-brand dark:border-stone-800 dark:bg-stone-900">{s}</button>
                ))}
              </div>
            </div>
          ) : active.messages.length === 0 ? <Empty>Empty chat</Empty> : (
            <div className="mx-auto max-w-3xl py-4">
              {active.messages.map((m, i) => m.role === 'user' ? (
                <div key={i} className="my-3 flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-brand/10 px-4 py-2.5 text-sm whitespace-pre-wrap dark:bg-brand/15">{m.text}</div>
                </div>
              ) : (
                <div key={i} className="my-3">
                  {m.tools.length > 0 && (
                    <details className="mb-2 text-xs text-stone-500" open={active.running && i === active.messages.length - 1}>
                      <summary className="cursor-pointer select-none">{m.tools.length} step{m.tools.length > 1 ? 's' : ''}</summary>
                      <ul className="mt-1 space-y-0.5 border-l-2 border-stone-200 pl-3 font-mono dark:border-stone-700">
                        {m.tools.map((t, j) => <li key={j} className="truncate">{t}</li>)}
                      </ul>
                    </details>
                  )}
                  <div className={cx('text-sm whitespace-pre-wrap break-words', m.error && 'text-red-600')}>
                    {m.text || (active.running && i === active.messages.length - 1
                      ? <span className="inline-flex items-center gap-2 text-stone-500"><span className="size-2 animate-pulse rounded-full bg-brand" />Thinking…</span>
                      : null)}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className="border-t border-stone-200 p-3 dark:border-stone-800">
          {error && <div className="mb-2 text-sm text-red-600">{error}</div>}
          {mode === 'edit' && <div className="mb-2 text-xs text-amber-600">Edit mode: Claude can change files and run commands in your project.</div>}
          <div className="mx-auto flex max-w-3xl gap-2">
            <textarea className={cx(inputCls, 'min-h-[42px] resize-none')} rows={Math.min(6, text.split('\n').length)} value={text}
              placeholder={active?.running ? 'Claude is working…' : 'Message your Claude…'}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!active?.running) void send(); } }} />
            {active?.running
              ? <Button onClick={() => bridge.myClaude.stop(active.id)}>Stop</Button>
              : <Button kind="primary" disabled={!text.trim()} onClick={() => void send()}>Send</Button>}
          </div>
        </div>
      </section>
    </div>
  );
}
