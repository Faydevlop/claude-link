import { useEffect, useState } from 'react';
import { api, getToken, setHubBase, setToken, setTokenOverride, type Member } from './api.ts';
import { desktop, type DesktopState } from './desktop.ts';
import { StoreProvider, useStore } from './store.tsx';
import { Button, cx, inputCls, ROLE_LABEL } from './ui.tsx';
import Chat, { ApprovalBanner } from './pages/Chat.tsx';
import StatusBoard from './pages/StatusBoard.tsx';
import Tasks from './pages/Tasks.tsx';
import Members from './pages/Members.tsx';
import Audit from './pages/Audit.tsx';
import Onboarding from './pages/Onboarding.tsx';
import MyClaude from './pages/MyClaude.tsx';
import Settings from './pages/Settings.tsx';

type Tab = 'status' | 'chat' | 'myclaude' | 'tasks' | 'requests' | 'members' | 'audit' | 'settings';

const LABEL: Record<Tab, string> = {
  status: 'Status', chat: 'Chat', myclaude: 'My Claude', tasks: 'Tasks', requests: 'Requests',
  members: 'Members', audit: 'Audit', settings: 'Settings',
};

function tabsFor(me: Member, isDesktop: boolean): Tab[] {
  if (me.isLead) return isDesktop
    ? ['status', 'chat', 'myclaude', 'tasks', 'members', 'audit', 'settings']
    : ['status', 'chat', 'tasks', 'members', 'audit'];
  return isDesktop ? ['chat', 'myclaude', 'requests', 'settings'] : ['chat'];
}

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
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-brand text-2xl text-white">⚭</div>
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

function Shell({ desktopState, onDesktopState, onLogout }: { desktopState?: DesktopState; onDesktopState?: (s: DesktopState) => void; onLogout?: () => void }) {
  const { me, connected, tasks, threads, joinRequests } = useStore();
  const tabs = tabsFor(me, !!desktopState);
  const readHash = (): Tab => { const h = location.hash.slice(1) as Tab; return tabs.includes(h) ? h : tabs[0]!; };
  const [tab, setTab] = useState<Tab>(readHash);
  useEffect(() => {
    const f = () => setTab(readHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, [me.isLead]); // eslint-disable-line react-hooks/exhaustive-deps

  const unread = threads.reduce((n, t) => n + (t.kind === 'channel' || t.participantIds.includes(me.id) ? t.unread : 0), 0);
  const approvals = tasks.filter(t => t.toId === me.id && t.status === 'pending_approval').length;
  const pendingJoins = joinRequests.filter(r => r.status === 'pending').length;
  const badge: Partial<Record<Tab, number>> = { chat: unread, requests: approvals, members: pendingJoins };

  const page = {
    status: <StatusBoard />, chat: <Chat />, tasks: <Tasks />, requests: <Tasks />, members: <Members />, audit: <Audit />,
    myclaude: desktopState ? <MyClaude projects={desktopState.settings?.projects ?? []} /> : null,
    settings: desktopState && onDesktopState ? <Settings state={desktopState} onState={onDesktopState} /> : null,
  }[tab];

  const live = desktopState ? desktopState.agent.connected && connected : connected;
  const encrypted = desktopState ? desktopState.security.encrypted : location.protocol === 'https:';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
        <div className="flex items-center gap-2 font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-brand text-white">⚭</span><span className="max-sm:hidden">Claude Link</span></div>
        {tabs.length > 1 && (
          <nav className="flex gap-1 overflow-x-auto">
            {tabs.map(t => (
              <a key={t} href={`#${t}`} aria-current={tab === t ? 'page' : undefined} className={cx('relative rounded-lg px-3 py-1.5 text-sm whitespace-nowrap', tab === t ? 'bg-stone-100 font-medium dark:bg-stone-800' : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100')}>
                {LABEL[t]}
                {!!badge[t] && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs text-white">{badge[t]}</span>}
              </a>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className={cx('text-xs', encrypted ? 'text-stone-500' : 'text-amber-600')}
            title={encrypted ? 'Traffic to the team server is encrypted' : 'Traffic to the team server is NOT encrypted'}>{encrypted ? '🔒' : '⚠ Unencrypted'}</span>
          <span role="status" className={cx('flex items-center gap-1.5 text-xs', live ? 'text-emerald-600' : 'text-amber-600')}>
            <span className={cx('size-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse')} />{live ? 'Live' : 'Reconnecting'}
          </span>
          <span className="max-sm:hidden"><b>{me.name}</b> <span className="text-stone-500">· {ROLE_LABEL[me.role]}</span></span>
          {onLogout && <Button kind="ghost" onClick={onLogout}>Sign out</Button>}
        </div>
      </header>
      <ApprovalBanner />
      <main className="min-h-0 flex-1 overflow-y-auto">{page}</main>
    </div>
  );
}

function BrowserApp() {
  const [me, setMe] = useState<Member | null | undefined>(getToken() ? undefined : null);
  useEffect(() => {
    if (me !== undefined) return;
    api<Member>('GET', '/api/me').then(setMe).catch(() => { setToken(null); setMe(null); });
  }, [me]);
  if (me === undefined) return null;
  if (!me) return <Login onLogin={setMe} />;
  return <StoreProvider me={me}><Shell onLogout={() => { setToken(null); setMe(null); }} /></StoreProvider>;
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand text-2xl text-white">⚭</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <div className="mt-2 text-sm text-stone-500">{children}</div>
      </div>
    </div>
  );
}

function DesktopApp() {
  const bridge = desktop!;
  const [state, setState] = useState<DesktopState | null>(null);
  const [me, setMe] = useState<Member | null>(null);
  const [meError, setMeError] = useState('');

  useEffect(() => {
    void bridge.getState().then(setState);
    return bridge.onEvent(e => {
      if (e.type === 'state') setState(e.state);
      if (e.type === 'navigate') location.hash = e.tab;
    });
  }, [bridge]);

  const s = state?.settings;
  const ready = !!s?.onboarded;
  const key = s ? `${s.hubUrl}|${s.token}` : '';

  // Point the shared web client at this machine's team and load who we are.
  useEffect(() => {
    if (!ready || !s) { setMe(null); return; }
    setHubBase(s.hubUrl);
    setTokenOverride(s.token);
    let cancelled = false;
    const load = () => api<Member>('GET', '/api/me')
      .then(m => { if (!cancelled) { setMe(m); setMeError(''); } })
      .catch(e => { if (!cancelled) { setMeError((e as Error).message); setTimeout(load, 3000); } });
    void load();
    return () => { cancelled = true; };
  }, [ready, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return null;
  if (!ready) return <Onboarding initial={state} onDone={setState} />;
  if (state.agent.revoked) return (
    <Centered title="You were disconnected from the team">
      The team lead removed this computer or issued you a new token.
      <div className="mt-4"><Button kind="primary" onClick={async () => setState(await bridge.leaveTeam())}>Set up again</Button></div>
    </Centered>
  );
  if (state.hub.error) return (
    <Centered title="Your team server couldn't start">
      {state.hub.error}
      <div className="mt-4"><Button onClick={async () => setState(await bridge.leaveTeam())}>Reset and set up again</Button></div>
    </Centered>
  );
  if (!me) return (
    <Centered title={`Connecting to ${s!.teamName}…`}>
      {meError ? <>Can't reach the team at {s!.hubUrl.replace(/^https?:\/\//, '')}. Make sure you're on the office Wi-Fi and the lead's Claude Link is open. Retrying…</> : 'Just a moment.'}
    </Centered>
  );
  return <StoreProvider key={key} me={me}><Shell desktopState={state} onDesktopState={setState} /></StoreProvider>;
}

export default function App() {
  return desktop ? <DesktopApp /> : <BrowserApp />;
}
