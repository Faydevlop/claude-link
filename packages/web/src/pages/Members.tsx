import { useState } from 'react';
import { api, hubUrl, timeAgo, type JoinRequest, type Member, type Role } from '../api.ts';
import { useStore } from '../store.tsx';
import { Button, Card, Copyable, Dot, inputCls, ROLE_LABEL } from '../ui.tsx';
import { OS } from './StatusBoard.tsx';

type Access = 'developer' | 'viewer';
const ACCESS_LABEL: Record<Access, string> = { developer: 'Developer', viewer: 'Viewer (questions only)' };
const ACCESS_HELP = 'Developers can ask questions and request code changes. Viewers can chat and ask questions, but cannot request changes.';

function JoinRequests({ onError }: { onError: (m: string) => void }) {
  const { joinRequests } = useStore();
  const [busy, setBusy] = useState<number | null>(null);
  const [access, setAccess] = useState<Record<number, Access>>({});
  const pending = joinRequests.filter(r => r.status === 'pending');
  if (!pending.length) return null;
  const decide = async (r: JoinRequest, approve: boolean) => {
    setBusy(r.id);
    try { await api('POST', `/api/join-requests/${r.id}/${approve ? 'approve' : 'reject'}`, approve ? { access: access[r.id] ?? 'developer' } : {}); }
    catch (e) { onError((e as Error).message); }
    setBusy(null);
  };
  return (
    <Card className="mb-4 border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="mb-1 font-medium">Waiting to join ({pending.length})</div>
      <p className="mb-2 text-xs text-stone-600 dark:text-stone-400">
        Ask the person for the code on their screen. Approve only if it matches the code shown here: a different code means the request did not come straight from their computer.
      </p>
      {pending.map(r => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-amber-200 py-2.5 first:border-0 dark:border-amber-500/20">
          <div className="min-w-0 flex-1 text-sm">
            <div><b>{r.name}</b> · {ROLE_LABEL[r.role]}</div>
            <div className="text-xs text-stone-500">{r.device} · {OS[r.os] ?? r.os} · {r.ip} · {timeAgo(r.createdAt)}</div>
          </div>
          {r.verificationCode && (
            <div className="text-center" title="Must match the code on the requester's screen">
              <div className="text-[10px] uppercase tracking-wide text-stone-500">Code</div>
              <div className="font-mono text-lg tracking-widest">{r.verificationCode}</div>
            </div>
          )}
          <select aria-label={`Access for ${r.name}`} className={inputCls + ' w-48 py-1'} value={access[r.id] ?? 'developer'} title={ACCESS_HELP}
            onChange={e => setAccess(a => ({ ...a, [r.id]: e.target.value as Access }))}>
            {(Object.keys(ACCESS_LABEL) as Access[]).map(a => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
          </select>
          <Button kind="primary" disabled={busy === r.id} onClick={() => decide(r, true)}>Approve</Button>
          <Button disabled={busy === r.id} onClick={() => decide(r, false)}>Decline</Button>
        </div>
      ))}
    </Card>
  );
}

const ROLES: Role[] = ['qa', 'frontend', 'backend', 'ai', 'other'];

function JoinInstructions({ name, token }: { name: string; token: string }) {
  const hub = hubUrl('');
  return (
    <Card className="mb-4 border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <div className="font-medium">Send these steps to {name}</div>
      <p className="mb-3 text-xs text-stone-600 dark:text-stone-400">The token is shown only once. It works as their password, so send it privately (not in a shared channel).</p>
      <ol className="space-y-3 text-sm">
        <li>1. Install the Claude Link app and open it.</li>
        <li>2. Choose <b>Join a team</b> → <b>I have a token</b>, and enter:
          <div className="mt-1 space-y-1">
            <Copyable text={hub.replace(/^https?:\/\//, '')} />
            <Copyable text={token} />
          </div></li>
        <li className="text-xs text-stone-500">Easier: they can pick your team from the list and send a join request instead. It shows up here for you to approve.</li>
      </ol>
    </Card>
  );
}

export default function Members() {
  const { members, me } = useStore();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('frontend');
  const [access, setAccess] = useState<Access>('developer');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');

  const guard = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
  };

  const add = () => guard(async () => {
    const r = await api<{ member: Member; token: string }>('POST', '/api/members', { name: name.trim(), role, access });
    setIssued({ name: r.member.name, token: r.token });
    setName('');
  });

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <h1 className="mb-4 text-xl font-semibold">Members</h1>
      {error && <div role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
      <JoinRequests onError={setError} />
      <Card className="mb-4">
        <div className="mb-3 font-medium">Add a teammate</div>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Name" className={inputCls + ' flex-1 min-w-40'} placeholder="Name" maxLength={60} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && void add()} />
          <select aria-label="Role" className={inputCls + ' w-36'} value={role} onChange={e => setRole(e.target.value as Role)}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <select aria-label="Access" className={inputCls + ' w-48'} value={access} title={ACCESS_HELP} onChange={e => setAccess(e.target.value as Access)}>
            {(Object.keys(ACCESS_LABEL) as Access[]).map(a => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
          </select>
          <Button kind="primary" disabled={!name.trim()} onClick={() => void add()}>Add member</Button>
        </div>
        <p className="mt-2 text-xs text-stone-500">{ACCESS_HELP} Fixes always need approval from the person whose computer they run on.</p>
      </Card>
      {issued && <JoinInstructions {...issued} />}
      <Card className="p-0">
        {members.map(m => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3 last:border-0 dark:border-stone-800">
            <Dot on={m.online} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{m.name}{m.id === me.id && <span className="ml-2 text-xs text-stone-400">(you)</span>}</div>
              <div className="truncate text-xs text-stone-500">
                {m.presence ? `${m.presence.device} · ${OS[m.presence.os] ?? m.presence.os} · ${m.presence.ip}${m.presence.appVersion ? ` · v${m.presence.appVersion}` : ''}` : `offline${m.lastDisconnectedAt ? ` since ${timeAgo(m.lastDisconnectedAt)}` : ''}`}
                {' · '}{m.repoPath ?? 'no project folder'}
                {' · '}last active {timeAgo(m.lastSeen)}
              </div>
            </div>
            {m.isLead ? <span className="text-sm text-stone-500">Team lead · admin</span> : (
              <>
                <select aria-label={`Role of ${m.name}`} className={inputCls + ' w-32 py-1'} value={m.role} onChange={e => void guard(() => api('PATCH', `/api/members/${m.id}`, { role: e.target.value }))}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <select aria-label={`Access of ${m.name}`} className={inputCls + ' w-48 py-1'} value={m.access} title={ACCESS_HELP} onChange={e => void guard(() => api('PATCH', `/api/members/${m.id}`, { access: e.target.value }))}>
                  {(Object.keys(ACCESS_LABEL) as Access[]).map(a => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
                </select>
                <Button onClick={() => void guard(async () => {
                  if (!confirm(`Issue a new token for ${m.name}? Their current token stops working immediately and their computer is disconnected.`)) return;
                  const r = await api<{ token: string }>('POST', `/api/members/${m.id}/token`);
                  setIssued({ name: m.name, token: r.token });
                })}>New token</Button>
                <Button kind="ghost" className="text-red-600" onClick={() => void guard(async () => {
                  if (confirm(`Remove ${m.name} from the team? Their computer is disconnected at once, their pending requests are cancelled, and their chat history is kept.`)) await api('DELETE', `/api/members/${m.id}`);
                })}>Remove</Button>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
