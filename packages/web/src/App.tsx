import { useEffect, useState } from 'react';
import { api, getToken, setToken, type Member } from './api.ts';
import { StoreProvider, useStore } from './store.tsx';
import { Button, cx, inputCls, ROLE_LABEL } from './ui.tsx';
import Chat from './pages/Chat.tsx';
import StatusBoard from './pages/StatusBoard.tsx';
import Tasks from './pages/Tasks.tsx';
import Members from './pages/Members.tsx';
import Audit from './pages/Audit.tsx';

const LEAD_TABS = { status: 'Status', chat: 'Chat', tasks: 'Tasks', members: 'Members', audit: 'Audit' } as const;
type Tab = keyof typeof LEAD_TABS;

function Login({ onLogin }: { onLogin: (m: Member) => void }) {
  const [token, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form className="w-full max-w-sm space-y-4" onSubmit={async e => {
        e.preventDefault();
        try {
          const me = await api<Member>('GET', '/api/me', undefined, token.trim());
          setToken(token.trim());
          onLogin(me);
        } catch (err) { setError((err as Error).message); }
      }}>
        <div className="text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-brand text-2xl text-white">✳︎</div>
          <h1 className="text-2xl font-semibold">Claude Link</h1>
          <p className="text-sm text-stone-500">Sign in with the token your team lead gave you.</p>
        </div>
        <input className={inputCls} type="password" placeholder="cl_…" value={token} onChange={e => setValue(e.target.value)} autoFocus />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <Button kind="primary" className="w-full py-2" disabled={!token.trim()}>Sign in</Button>
      </form>
    </div>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { me, connected, tasks, threads } = useStore();
  const readHash = (): Tab => { const h = location.hash.slice(1); return h in LEAD_TABS ? (h as Tab) : 'status'; };
  const [tab, setTab] = useState<Tab>(me.isLead ? readHash() : 'chat');
  useEffect(() => {
    const f = () => setTab(readHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const unread = threads.reduce((n, t) => n + (t.kind === 'channel' || t.participantIds.includes(me.id) ? t.unread : 0), 0);
  const approvals = tasks.filter(t => t.toId === me.id && t.status === 'pending_approval').length;

  const page = !me.isLead ? <Chat /> : { status: <StatusBoard />, chat: <Chat />, tasks: <Tasks />, members: <Members />, audit: <Audit /> }[tab];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center gap-2 font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-brand text-white">✳︎</span><span className="max-sm:hidden">Claude Link</span></div>
        {me.isLead && (
          <nav className="flex gap-1 overflow-x-auto">
            {(Object.keys(LEAD_TABS) as Tab[]).map(t => (
              <a key={t} href={`#${t}`} className={cx('relative rounded-lg px-3 py-1.5 text-sm whitespace-nowrap', tab === t ? 'bg-stone-100 font-medium dark:bg-stone-800' : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100')}>
                {LEAD_TABS[t]}
                {t === 'chat' && unread + approvals > 0 && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs text-white">{unread + approvals}</span>}
              </a>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className={cx('flex items-center gap-1.5 text-xs', connected ? 'text-emerald-600' : 'text-amber-600')}>
            <span className={cx('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse')} />{connected ? 'Live' : 'Reconnecting'}
          </span>
          <span className="max-sm:hidden"><b>{me.name}</b> <span className="text-stone-500">· {ROLE_LABEL[me.role]}</span></span>
          <Button kind="ghost" onClick={onLogout}>Sign out</Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{page}</main>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Member | null | undefined>(getToken() ? undefined : null);
  useEffect(() => {
    if (me !== undefined) return;
    api<Member>('GET', '/api/me').then(setMe).catch(() => { setToken(null); setMe(null); });
  }, [me]);
  if (me === undefined) return null;
  if (!me) return <Login onLogin={setMe} />;
  return <StoreProvider me={me}><Shell onLogout={() => { setToken(null); setMe(null); }} /></StoreProvider>;
}
