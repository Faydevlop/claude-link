import { useState, type ReactNode } from 'react';
import { desktop, type DesktopState } from '../desktop.ts';
import { Button, Card, Copyable, cx } from '../ui.tsx';

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

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
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

  const update = async (patch: Parameters<typeof bridge.updateSettings>[0]) => {
    setBusy(true); setError('');
    try { onState(await bridge.updateSettings(patch)); }
    catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setBusy(false);
  };

  const teamAddress = s.role === 'lead' && state.hub.addresses[0] ? `${state.hub.addresses[0]}:${s.port ?? 4545}` : s.hubUrl.replace(/^https?:\/\//, '');

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

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
        <Row title="Project folder" detail={s.repoPath ?? 'Not set. Teammates\' questions can\'t be answered until you choose one.'}>
          <Button disabled={busy} onClick={async () => {
            const f = await bridge.pickProjectFolder();
            if (!f) return;
            if (!f.isGit) { setError('That folder is not a git repository. Choose your project\'s root folder.'); return; }
            await update({ repoPath: f.path });
          }}>Change…</Button>
        </Row>
      </Card>

      <Card className="mb-4 py-0">
        <Row title="Answer teammates' questions automatically" detail="Read-only. When off, you approve each question in a dialog.">
          <Toggle on={s.autoApproveReads} disabled={busy} onChange={v => update({ autoApproveReads: v })} />
        </Row>
        <Row title="Code changes need your approval" detail="Always on. Fixes run on a separate branch only after you approve.">
          <Toggle on disabled onChange={() => {}} />
        </Row>
        <Row title="Start when I log in" detail="Keeps you reachable by your team.">
          <Toggle on={s.launchAtLogin} disabled={busy} onChange={v => update({ launchAtLogin: v })} />
        </Row>
        <Row title="Use Claude Link in VS Code / terminal Claude Code"
          detail="Adds the team tools (ask a teammate's Claude, report status…) to your regular Claude Code too. Off by default so your editor setup is untouched.">
          <Toggle on={s.claudeCodeIntegration} disabled={busy} onChange={v => update({ claudeCodeIntegration: v })} />
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
