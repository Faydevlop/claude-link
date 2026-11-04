import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { desktop, type DesktopState } from '../desktop.ts';
import { Button, Card, Copyable, cx, inputCls } from '../ui.tsx';
import ProjectsPicker, { type ProjectSelection } from '../ProjectsPicker.tsx';

function Row({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 py-4 last:border-0 dark:border-stone-800">
      <div className="min-w-60 flex-1 text-sm">
        <div className="font-medium">{title}</div>
        {detail && <div className="mt-0.5 break-words text-stone-500">{detail}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50', on ? 'bg-brand' : 'bg-stone-300 dark:bg-stone-700')}>
      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

export default function Settings({ state, onState }: { state: DesktopState; onState: (s: DesktopState) => void }) {
  const bridge = desktop!;
  const s = state.settings!;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const projects = s.projects ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProjectSelection>({ projects, workspaceRoot: s.workspaceRoot ?? null });

  const update = async (patch: Parameters<typeof bridge.updateSettings>[0]) => {
    setBusy(true); setError('');
    try { onState(await bridge.updateSettings(patch)); }
    catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setBusy(false);
  };

  const teamAddress = s.role === 'lead' && state.hub.addresses[0] ? `${state.hub.addresses[0]}:${s.port ?? 4545}` : s.hubUrl.replace(/^https?:\/\//, '');

  // Lead only: how long an unused token keeps working.
  const [idleDays, setIdleDays] = useState<number | null>(null);
  useEffect(() => {
    if (s.role !== 'lead') return;
    api<{ tokenIdleDays: number }>('GET', '/api/team').then(t => setIdleDays(t.tokenIdleDays)).catch(() => {});
  }, [s.role]);
  const saveIdleDays = async (days: number) => {
    setError('');
    try { setIdleDays((await api<{ tokenIdleDays: number }>('PATCH', '/api/team', { tokenIdleDays: days })).tokenIdleDays); }
    catch (e) { setError((e as Error).message); }
  };
  const extraFixTools = s.fixAllowedTools ?? [];

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      {error && <div role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <Card className="mb-4 py-0">
        <Row title="Team" detail={<>{s.teamName} · you are <b>{s.name}</b> ({s.role === 'lead' ? 'team lead' : 'member'})</>}>
          <span className={cx('flex items-center gap-1.5 text-sm', state.agent.connected ? 'text-emerald-600' : 'text-amber-600')}>
            <span className={cx('size-2 rounded-full', state.agent.connected ? 'bg-emerald-500' : 'bg-amber-500')} />
            {state.agent.connected ? 'Connected' : state.agent.revoked ? 'Disconnected by lead' : 'Reconnecting…'}
          </span>
        </Row>
        {s.role === 'lead' && (
          <Row title="Team address" detail={state.hub.error ?? 'Teammates find your team automatically. If they can\'t, give them this address.'}>
            <div className="w-full sm:w-72"><Copyable text={teamAddress} /></div>
          </Row>
        )}
        <Row title="Projects" detail={projects.length
          ? <>{projects.map(p => p.name).join(', ')}{s.workspaceRoot && <span className="block font-mono text-xs">{s.workspaceRoot}</span>}</>
          : 'None yet. Teammates\' questions can\'t be answered until you add one.'}>
          <Button disabled={busy} onClick={() => { setDraft({ projects, workspaceRoot: s.workspaceRoot ?? null }); setEditing(e => !e); }}>{editing ? 'Cancel' : 'Change…'}</Button>
        </Row>
        {editing && (
          <div className="border-b border-stone-100 pb-4 dark:border-stone-800">
            <ProjectsPicker value={draft} onChange={setDraft} />
            <div className="mt-3 flex justify-end">
              <Button kind="primary" disabled={busy || !draft.projects.length} onClick={async () => { await update(draft); setEditing(false); }}>Save projects</Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="mb-4 py-0">
        <Row title="Connection to the team"
          detail={state.security.encrypted
            ? <>Encrypted (TLS). This computer only talks to the team server whose certificate it saw when it joined. Compare this fingerprint with the one in your lead's Settings:</>
            : <span className="text-amber-700 dark:text-amber-400">Not encrypted. The team server is an older version, or was started without encryption. Use it only on a network you trust.</span>}>
          <span className={cx('rounded-full px-2 py-0.5 text-xs', state.security.encrypted ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300')}>
            {state.security.encrypted ? '🔒 Encrypted' : 'Not encrypted'}
          </span>
        </Row>
        {state.security.fingerprint && <div className="border-b border-stone-100 pb-4 dark:border-stone-800"><Copyable text={state.security.fingerprint} /></div>}
        <Row title="What teammates' questions can do" detail="Your Claude reads your projects and their git history. It cannot change files, run commands, use the web, or read secrets such as .env files, SSH keys or your Claude Link token.">
          <span className="text-xs text-stone-500">Read-only</span>
        </Row>
        <Row title="What an approved fix can do"
          detail={<>Your Claude edits separate copies of your projects and commits to a new branch. It cannot touch your own checkout, git settings or secrets, and nothing is merged or pushed.{' '}
            {extraFixTools.length ? <>It may also run: <code>{extraFixTools.join(', ')}</code> (from your config file).</> : 'It cannot run commands.'}</>}>
          <span className="text-xs text-stone-500">Needs your approval</span>
        </Row>
        {s.role === 'lead' && idleDays !== null && (
          <Row title="Unused tokens expire" detail="A teammate's token that has not been used for this long stops working (for example a lost laptop). Your own token is exempt.">
            <select aria-label="Token expiry" className={inputCls + ' w-36'} value={idleDays} onChange={e => void saveIdleDays(Number(e.target.value))}>
              {[[7, 'After 7 days'], [14, 'After 14 days'], [30, 'After 30 days'], [90, 'After 90 days'], [0, 'Never']].map(([d, l]) => <option key={d} value={d}>{l}</option>)}
            </select>
          </Row>
        )}
      </Card>

      <Card className="mb-4 py-0">
        <Row title="Answer teammates' questions automatically" detail="Read-only. When off, you approve each question in a dialog.">
          <Toggle label="Answer questions automatically" on={s.autoApproveReads} disabled={busy} onChange={v => update({ autoApproveReads: v })} />
        </Row>
        <Row title="Code changes need your approval" detail="Always on. Fixes run on a separate branch only after you approve them on this computer.">
          <Toggle label="Code changes need approval" on disabled onChange={() => {}} />
        </Row>
        <Row title="Start when I log in" detail="Keeps you reachable by your team.">
          <Toggle label="Start when I log in" on={s.launchAtLogin} disabled={busy} onChange={v => update({ launchAtLogin: v })} />
        </Row>
        <Row title="Use Claude Link in VS Code / terminal Claude Code"
          detail="Adds the team tools (ask a teammate's Claude, report status…) to your regular Claude Code too. Off by default so your editor setup is untouched.">
          <Toggle label="Use Claude Link in other Claude Code sessions" on={s.claudeCodeIntegration} disabled={busy} onChange={v => update({ claudeCodeIntegration: v })} />
        </Row>
        <Row title="Notifications" detail="Check that alerts reach you.">
          <Button onClick={() => bridge.testNotification()}>Send test</Button>
        </Row>
      </Card>

      <Card className="mb-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">Activity log</span>
          <span className="text-xs text-stone-400">Claude Link {state.version}</span>
        </div>
        <pre className="max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-xs leading-relaxed text-stone-300">
          {state.log.length ? state.log.join('\n') : 'Nothing yet.'}
        </pre>
      </Card>

      <Card className="border-red-200 dark:border-red-500/30">
        <Row title={s.role === 'lead' ? 'Stop hosting this team' : 'Leave team'}
          detail={s.role === 'lead'
            ? 'Stops the team server on this computer. Chat history stays on this computer; creating the team again restores it.'
            : 'Disconnects this computer. Your lead can approve you again later.'}>
          <Button kind="danger" onClick={async () => {
            if (!confirm(s.role === 'lead' ? 'Stop hosting the team? Teammates will be disconnected.' : 'Leave the team?')) return;
            onState(await bridge.leaveTeam());
          }}>{s.role === 'lead' ? 'Stop team' : 'Leave team'}</Button>
        </Row>
      </Card>
    </div>
  );
}
