import { useState } from 'react';
import { api, timeAgo, type Member, type Role } from '../api.ts';
import { useStore } from '../store.tsx';
import { Button, Card, Copyable, Dot, inputCls, ROLE_LABEL } from '../ui.tsx';

const ROLES: Role[] = ['qa', 'frontend', 'backend', 'ai', 'other'];

function JoinInstructions({ name, token }: { name: string; token: string }) {
  const hub = location.origin;
  return (
    <Card className="mb-4 border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <div className="font-medium">Send these steps to {name}</div>
      <p className="mb-3 text-xs text-stone-600 dark:text-stone-400">The token is shown only once. It works as their password for the web chat too.</p>
      <ol className="space-y-3 text-sm">
        <li>1. Get Claude Link (clone the repo, run <code>npm install &amp;& npm run build</code>, then <code>cd packages/cli &amp;& npm link</code>), then join:
          <Copyable text={`claude-link join ${hub} --token ${token} --repo <path-to-your-project>`} /></li>
        <li>2. Keep the agent running so other Claudes can reach theirs:<Copyable text="claude-link agent" /></li>
        <li>3. Chat in the browser: <a className="text-brand underline" href={hub}>{hub}</a></li>
      </ol>
    </Card>
  );
}

export default function Members() {
  const { members, me } = useStore();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('frontend');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const add = async () => {
    try {
      const r = await api<{ member: Member; token: string }>('POST', '/api/members', { name, role });
      setIssued({ name: r.member.name, token: r.token });
      setName('');
    } catch (e) { alert((e as Error).message); }
  };

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <h1 className="mb-4 text-xl font-semibold">Members</h1>
      <Card className="mb-4">
        <div className="mb-3 font-medium">Add a teammate</div>
        <div className="flex flex-wrap gap-2">
          <input className={inputCls + ' flex-1 min-w-40'} placeholder="Name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && add()} />
          <select className={inputCls + ' w-40'} value={role} onChange={e => setRole(e.target.value as Role)}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <Button kind="primary" disabled={!name.trim()} onClick={add}>Add member</Button>
        </div>
      </Card>
      {issued && <JoinInstructions {...issued} />}
      <Card className="p-0">
        {members.map(m => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3 last:border-0 dark:border-stone-800">
            <Dot on={m.online} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{m.name}{m.id === me.id && <span className="ml-2 text-xs text-stone-400">(you)</span>}</div>
              <div className="truncate text-xs text-stone-500">{m.repoPath ?? 'no repo reported'} · seen {timeAgo(m.lastSeen)}</div>
            </div>
            {m.isLead ? <span className="text-sm text-stone-500">Team lead</span> : (
              <>
                <select className={inputCls + ' w-32 py-1'} value={m.role} onChange={e => api('PATCH', `/api/members/${m.id}`, { role: e.target.value }).catch(err => alert(err.message))}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <Button onClick={async () => {
                  if (!confirm(`Issue a new token for ${m.name}? Their current token stops working immediately.`)) return;
                  const r = await api<{ token: string }>('POST', `/api/members/${m.id}/token`);
                  setIssued({ name: m.name, token: r.token });
                }}>New token</Button>
                <Button kind="ghost" className="text-red-600" onClick={async () => {
                  if (confirm(`Remove ${m.name} from the team? Their chat history is kept.`)) await api('DELETE', `/api/members/${m.id}`).catch(err => alert(err.message));
                }}>Remove</Button>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
