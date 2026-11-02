import { useEffect, useState, type ReactNode } from 'react';
import type { Role } from '../api.ts';
import { desktop, type DesktopState, type DiscoveredTeam, type Prerequisites } from '../desktop.ts';
import { Button, cx, inputCls, ROLE_LABEL } from '../ui.tsx';
import ProjectsPicker, { type ProjectSelection } from '../ProjectsPicker.tsx';

type Path = 'lead' | 'member';
type Step = 'welcome' | 'prereqs' | 'lead' | 'find' | 'token' | 'waiting' | 'folder' | 'permissions';

const STEPS: Record<Path, Step[]> = {
  lead: ['welcome', 'prereqs', 'lead', 'folder', 'permissions'],
  member: ['welcome', 'prereqs', 'find', 'waiting', 'folder', 'permissions'],
};

function Frame({ step, path, title, subtitle, children }: { step: Step; path: Path | null; title: string; subtitle?: string; children: ReactNode }) {
  const steps = path ? STEPS[path] : STEPS.member;
  const index = steps.indexOf(step === 'token' ? 'find' : step);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-brand text-lg text-white">⚭</div>
          <div className="font-semibold">Claude Link</div>
          {path && index > 0 && (
            <div className="ml-auto flex gap-1.5">
              {steps.slice(1).map((s, i) => <span key={s} className={cx('h-1.5 w-6 rounded-full', i < index ? 'bg-brand' : 'bg-stone-300 dark:bg-stone-700')} />)}
            </div>
          )}
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1.5 text-stone-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

const Error = ({ text }: { text: string }) => text ? <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{text}</div> : null;

function Check({ ok, label, detail, children }: { ok: boolean | null; label: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <span className={cx('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-sm text-white', ok === null ? 'bg-stone-300' : ok ? 'bg-emerald-500' : 'bg-red-500')}>
        {ok === null ? '…' : ok ? '✓' : '!'}
      </span>
      <div className="min-w-0 text-sm">
        <div className="font-medium">{label}</div>
        <div className="break-words text-stone-500">{detail}</div>
        {children}
      </div>
    </div>
  );
}

export default function Onboarding({ initial, onDone }: { initial: DesktopState; onDone: (s: DesktopState) => void }) {
  const bridge = desktop!;
  const resumed = initial.settings && !initial.settings.onboarded;
  const [path, setPath] = useState<Path | null>(resumed ? initial.settings!.role : null);
  const [step, setStep] = useState<Step>(resumed ? 'folder' : 'welcome');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(initial);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setBusy(false);
  };

  // ---- step: prerequisites ----
  const [prereqs, setPrereqs] = useState<Prerequisites | null>(null);
  const checkPrereqs = () => { setPrereqs(null); void bridge.checkPrerequisites().then(setPrereqs); };
  useEffect(() => { if (step === 'prereqs') checkPrereqs(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- step: lead ----
  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [port, setPort] = useState('4545');

  // ---- step: find team ----
  const [teams, setTeams] = useState<DiscoveredTeam[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [role, setRole] = useState<Role>('frontend');
  const [token, setToken] = useState('');
  const scan = () => { setTeams(null); void bridge.discoverTeams().then(t => { setTeams(t); if (t.length === 1) setSelected(t[0]!.url); }); };
  useEffect(() => { if (step === 'find') scan(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- step: waiting for approval ----
  const [waitStatus, setWaitStatus] = useState('pending');
  useEffect(() => {
    if (step !== 'waiting') return;
    const t = setInterval(async () => {
      try {
        const r = await bridge.pollJoin();
        setWaitStatus(r.status);
        if (r.status === 'approved') { clearInterval(t); setState(await bridge.getState()); setStep('folder'); }
        if (r.status === 'rejected') clearInterval(t);
      } catch { /* hub briefly unreachable; keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- step: projects ----
  const [selection, setSelection] = useState<ProjectSelection>({
    projects: initial.settings?.projects ?? [], workspaceRoot: initial.settings?.workspaceRoot ?? null,
  });

  // ---- step: permissions ----
  const [autoReads, setAutoReads] = useState(true);
  const [atLogin, setAtLogin] = useState(true);
  const [notified, setNotified] = useState(false);

  const isMac = state.platform === 'darwin';

  if (step === 'welcome') return (
    <Frame step={step} path={path} title="Welcome to Claude Link" subtitle="Connect your team's Claude Code over the office Wi-Fi: chat with teammates, ask their Claude about their code, and see everyone's progress.">
      <div className="grid gap-3 sm:grid-cols-2">
        {([['lead', 'Create a team', 'I\'m the team lead. This computer hosts the team.'], ['member', 'Join a team', 'My team lead already started Claude Link.']] as const).map(([p, t, d]) => (
          <button key={p} onClick={() => { setPath(p); setStep('prereqs'); }}
            className="rounded-xl border border-stone-300 bg-white p-5 text-left transition hover:border-brand hover:shadow-sm dark:border-stone-700 dark:bg-stone-900">
            <div className="text-2xl">{p === 'lead' ? '👑' : '👋'}</div>
            <div className="mt-2 font-semibold">{t}</div>
            <div className="mt-1 text-sm text-stone-500">{d}</div>
          </button>
        ))}
      </div>
    </Frame>
  );

  if (step === 'prereqs') {
    const ok = prereqs?.claude.ok && prereqs.git.ok;
    return (
      <Frame step={step} path={path} title="Checking this computer" subtitle="Claude Link uses your own Claude Code to answer teammates, so it needs to be installed and logged in.">
        <div className="space-y-3">
          <Check ok={prereqs ? prereqs.claude.ok : null} label="Claude Code" detail={prereqs ? (prereqs.claude.version ?? 'Not found') : 'Checking…'}>
            {prereqs && !prereqs.claude.ok && (
              <div className="mt-2 space-y-1 text-stone-600 dark:text-stone-400">
                <div>Install it, then open a terminal and run <code className="rounded bg-stone-100 px-1 dark:bg-stone-800">claude</code> once to log in.</div>
                <button className="text-brand underline" onClick={() => bridge.openExternal('https://claude.com/claude-code')}>How to install Claude Code →</button>
              </div>
            )}
            {prereqs?.claude.ok && <div className="mt-1 text-xs text-stone-400">Make sure you've logged in at least once by running <code>claude</code> in a terminal.</div>}
          </Check>
          <Check ok={prereqs ? prereqs.git.ok : null} label="Git" detail={prereqs ? (prereqs.git.version ?? 'Not found') : 'Checking…'}>
            {prereqs && !prereqs.git.ok && (
              <button className="mt-2 text-brand underline" onClick={() => bridge.openExternal('https://git-scm.com/downloads')}>Download Git →</button>
            )}
          </Check>
        </div>
        <div className="mt-6 flex justify-between">
          <Button onClick={() => setStep('welcome')}>Back</Button>
          <div className="flex gap-2">
            <Button onClick={checkPrereqs} disabled={!prereqs}>Check again</Button>
            <Button kind="primary" disabled={!ok} onClick={() => setStep(path === 'lead' ? 'lead' : 'find')}>Continue</Button>
          </div>
        </div>
      </Frame>
    );
  }

  if (step === 'lead') return (
    <Frame step={step} path={path} title="Create your team" subtitle="This computer becomes the team's hub. Keep Claude Link running while your team works.">
      <div className="space-y-4">
        <label className="block text-sm font-medium">Your name<input className={cx(inputCls, 'mt-1')} value={name} onChange={e => setName(e.target.value)} placeholder="Fayis" autoFocus /></label>
        <label className="block text-sm font-medium">Team name<input className={cx(inputCls, 'mt-1')} value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="Clinica One" /></label>
        <details className="text-sm text-stone-500">
          <summary className="cursor-pointer">Advanced</summary>
          <label className="mt-2 block font-medium text-stone-900 dark:text-stone-100">Port<input className={cx(inputCls, 'mt-1 w-32')} value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} /></label>
        </details>
        {isMac && (
          <div className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
            macOS may ask <b>"Do you want the application Claude Link to accept incoming network connections?"</b> Click <b>Allow</b> so teammates can connect.
          </div>
        )}
        {!isMac && (
          <div className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
            Windows may show a <b>Windows Defender Firewall</b> prompt. Tick <b>Private networks</b> and click <b>Allow access</b>.
          </div>
        )}
      </div>
      <Error text={error} />
      <div className="mt-6 flex justify-between">
        <Button onClick={() => setStep('prereqs')}>Back</Button>
        <Button kind="primary" disabled={busy || !name.trim() || !teamName.trim() || !port} onClick={() => run(async () => {
          setState(await bridge.createTeam({ name: name.trim(), teamName: teamName.trim(), port: Number(port) }));
          setStep('folder');
        })}>{busy ? 'Starting…' : 'Create team'}</Button>
      </div>
    </Frame>
  );

  if (step === 'find') {
    const target = selected ?? (manual.trim() || null);
    return (
      <Frame step={step} path={path} title="Join your team" subtitle="Teams on this Wi-Fi show up below. Your lead approves your request from their app.">
        <div className="rounded-xl border border-stone-200 dark:border-stone-800">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:border-stone-800">
            <span>Teams found on this network</span>
            <button className="normal-case text-brand" onClick={scan} disabled={teams === null}>{teams === null ? 'Searching…' : 'Search again'}</button>
          </div>
          {teams === null && <div className="p-4 text-sm text-stone-500">Looking for teams…</div>}
          {teams?.length === 0 && <div className="p-4 text-sm text-stone-500">No teams found. Make sure your lead's Claude Link is open and you're on the same Wi-Fi, or enter the address below.</div>}
          {teams?.map(t => (
            <button key={t.url} onClick={() => { setSelected(t.url); setManual(''); }}
              className={cx('flex w-full items-center gap-3 px-4 py-3 text-left', selected === t.url ? 'bg-brand/10' : 'hover:bg-stone-50 dark:hover:bg-stone-800/50')}>
              <span className={cx('size-4 rounded-full border-2', selected === t.url ? 'border-brand bg-brand' : 'border-stone-300')} />
              <div className="min-w-0 flex-1"><div className="font-medium">{t.team}</div><div className="text-xs text-stone-500">Lead: {t.lead ?? '?'} · {t.url.replace('http://', '')}</div></div>
            </button>
          ))}
        </div>
        <label className="mt-4 block text-sm font-medium">Or enter the address your lead gave you
          <input className={cx(inputCls, 'mt-1')} value={manual} placeholder="192.168.1.77:4545" onChange={e => { setManual(e.target.value); setSelected(null); }} />
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">Your name<input className={cx(inputCls, 'mt-1')} value={name} onChange={e => setName(e.target.value)} placeholder="Rahul" /></label>
          <label className="block text-sm font-medium">Your role
            <select className={cx(inputCls, 'mt-1')} value={role} onChange={e => setRole(e.target.value as Role)}>
              {(['frontend', 'backend', 'qa', 'ai', 'other'] as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
        </div>
        <Error text={error} />
        <div className="mt-6 flex items-center justify-between">
          <Button onClick={() => setStep('prereqs')}>Back</Button>
          <div className="flex items-center gap-3">
            <button className="text-sm text-stone-500 underline" onClick={() => { setError(''); setStep('token'); }}>I have a token</button>
            <Button kind="primary" disabled={busy || !target || !name.trim()} onClick={() => run(async () => {
              await bridge.requestJoin({ hubUrl: target!, name: name.trim(), role });
              setWaitStatus('pending');
              setStep('waiting');
            })}>{busy ? 'Sending…' : 'Send join request'}</Button>
          </div>
        </div>
      </Frame>
    );
  }

  if (step === 'token') return (
    <Frame step={step} path={path} title="Join with a token" subtitle="If your lead added you from the Members page, paste the address and token they sent you.">
      <div className="space-y-4">
        <label className="block text-sm font-medium">Team address<input className={cx(inputCls, 'mt-1')} value={manual} onChange={e => setManual(e.target.value)} placeholder="192.168.1.77:4545" /></label>
        <label className="block text-sm font-medium">Token<input className={cx(inputCls, 'mt-1')} type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="cl_…" /></label>
      </div>
      <Error text={error} />
      <div className="mt-6 flex justify-between">
        <Button onClick={() => setStep('find')}>Back</Button>
        <Button kind="primary" disabled={busy || !manual.trim() || !token.trim()} onClick={() => run(async () => {
          setState(await bridge.joinWithToken({ hubUrl: manual.trim(), token: token.trim() }));
          setStep('folder');
        })}>Join</Button>
      </div>
    </Frame>
  );

  if (step === 'waiting') return (
    <Frame step={step} path={path} title={waitStatus === 'rejected' ? 'Request declined' : 'Waiting for approval…'}
      subtitle={waitStatus === 'rejected' ? 'Your team lead declined the request. Check with them and try again.' : 'Your team lead got a notification. This page continues automatically once they approve.'}>
      {waitStatus !== 'rejected'
        ? <div className="flex items-center gap-3 rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800"><span className="size-3 animate-pulse rounded-full bg-amber-500" />Request sent as <b>{name}</b> ({ROLE_LABEL[role]})</div>
        : <Button onClick={() => setStep('find')}>Try again</Button>}
    </Frame>
  );

  if (step === 'folder') return (
    <Frame step={step} path={path} title="Choose your projects"
      subtitle="Teammates' questions are answered from these projects, and approved fixes are made on a new branch in them. Your own work is never touched.">
      <ProjectsPicker value={selection} onChange={setSelection} />
      <Error text={error} />
      <div className="mt-6 flex justify-between">
        <button className="text-sm text-stone-500 underline" onClick={() => setStep('permissions')}>Skip for now</button>
        <Button kind="primary" disabled={busy || !selection.projects.length} onClick={() => run(async () => {
          setState(await bridge.updateSettings(selection));
          setStep('permissions');
        })}>Continue</Button>
      </div>
    </Frame>
  );

  // permissions
  return (
    <Frame step="permissions" path={path} title="Permissions" subtitle="You can change these any time in Settings.">
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
          <div className="flex-1 text-sm"><div className="font-medium">Notifications</div><div className="text-stone-500">Get alerted when a teammate messages you or needs your approval.</div></div>
          <Button onClick={() => { void bridge.testNotification(); setNotified(true); }}>{notified ? 'Sent ✓' : 'Send test'}</Button>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
          <input type="checkbox" className="mt-1 accent-[var(--color-brand)]" checked={autoReads} onChange={e => setAutoReads(e.target.checked)} />
          <div className="text-sm"><div className="font-medium">Answer teammates' questions automatically</div><div className="text-stone-500">Your Claude can read (never change) your project to answer them. Turn off to approve each question.</div></div>
        </label>
        <div className="flex items-start gap-3 rounded-xl border border-stone-200 p-4 opacity-80 dark:border-stone-800">
          <input type="checkbox" checked disabled className="mt-1" />
          <div className="text-sm"><div className="font-medium">Code changes always need your approval</div><div className="text-stone-500">Fix requests run only after you click Approve, on a separate branch. This can't be turned off.</div></div>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
          <input type="checkbox" className="mt-1 accent-[var(--color-brand)]" checked={atLogin} onChange={e => setAtLogin(e.target.checked)} />
          <div className="text-sm"><div className="font-medium">Start Claude Link when I log in</div><div className="text-stone-500">Keeps you reachable without remembering to open it.</div></div>
        </label>
      </div>
      <Error text={error} />
      <div className="mt-6 flex justify-end">
        <Button kind="primary" disabled={busy} onClick={() => run(async () => {
          await bridge.updateSettings({ autoApproveReads: autoReads, launchAtLogin: atLogin });
          onDone(await bridge.finishOnboarding());
        })}>Finish setup</Button>
      </div>
    </Frame>
  );
}
