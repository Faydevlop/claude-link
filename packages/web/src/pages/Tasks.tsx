import { useState } from 'react';
import { api, timeAgo, type Task } from '../api.ts';
import { useStore } from '../store.tsx';
import { Badge, Button, Card, cx, Diff, Empty, inputCls, ModeTag } from '../ui.tsx';

function AssignForm({ onDone }: { onDone: () => void }) {
  const { me, members } = useStore();
  const others = members.filter(m => m.id !== me.id);
  const [toId, setToId] = useState(others[0]?.id ?? 0);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  return (
    <Card className="mb-4 space-y-3">
      <div className="font-medium">Assign a task</div>
      <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
        <select className={inputCls} value={toId} onChange={e => setToId(Number(e.target.value))}>
          {others.map(m => <option key={m.id} value={m.id}>{m.name} — {m.role}</option>)}
        </select>
        <input className={inputCls} placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
      </div>
      <textarea className={inputCls} rows={3} placeholder="Details / acceptance criteria" value={details} onChange={e => setDetails(e.target.value)} />
      {error && <div role="alert" className="text-sm text-red-600">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button kind="primary" disabled={!title.trim() || !details.trim()} onClick={async () => {
          setError('');
          try { await api('POST', '/api/tasks', { toId, mode: 'assignment', title, prompt: details }); onDone(); }
          catch (e) { setError((e as Error).message); }
        }}>Assign</Button>
      </div>
    </Card>
  );
}

function Row({ t }: { t: Task }) {
  const { memberName } = useStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-stone-100 last:border-0 dark:border-stone-800">
      <button aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800/50" onClick={() => setOpen(o => !o)}>
        <span className="w-10 text-stone-400">#{t.id}</span>
        <ModeTag mode={t.mode} />
        <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
        <span className="text-xs text-stone-500">{memberName(t.fromId)} → {memberName(t.toId)}</span>
        <span className="w-16 text-right text-xs text-stone-400">{timeAgo(t.updatedAt)}</span>
        <Badge value={t.status} />
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-4 pl-16 text-sm">
          <div><div className="text-xs font-semibold uppercase text-stone-500">Request</div><p className="whitespace-pre-wrap">{t.prompt}</p></div>
          {t.result && <div><div className="text-xs font-semibold uppercase text-stone-500">{t.status === 'running' ? 'Progress' : 'Result'}</div><p className="whitespace-pre-wrap">{t.result}</p></div>}
          {t.mode === 'fix' && t.approvedBy && (
            <div className="text-xs text-stone-500">Approved by {memberName(t.approvedBy)}{t.approvedAt ? ` · ${new Date(t.approvedAt).toLocaleString()}` : ''}{t.approvalHash ? ` · request fingerprint ${t.approvalHash.slice(0, 12)}` : ''}</div>
          )}
          {t.branch && <div className="text-xs">Branch: <code className="rounded bg-stone-100 px-1 dark:bg-stone-800">{t.branch}</code> — review with <code className="rounded bg-stone-100 px-1 dark:bg-stone-800">git diff HEAD...{t.branch}</code>, then merge it yourself if you want it. Nothing was merged or pushed automatically.</div>}
          {t.diff && <Diff diff={t.diff} />}
        </div>
      )}
    </div>
  );
}

const FILTERS = { active: ['pending_approval', 'queued', 'running', 'open', 'in_progress', 'blocked'], done: ['done', 'rejected', 'failed'], all: null } as const;

export default function Tasks() {
  const { tasks, me } = useStore();
  const [filter, setFilter] = useState<keyof typeof FILTERS>('active');
  const [assigning, setAssigning] = useState(false);
  const allowed = FILTERS[filter] as readonly string[] | null;
  const shown = tasks.filter(t => !allowed || allowed.includes(t.status));
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{me.isLead ? 'Tasks' : 'Requests'}</h1>
        <div className="flex rounded-lg bg-stone-200/70 p-0.5 text-sm dark:bg-stone-800">
          {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={cx('rounded-md px-3 py-1 capitalize', filter === f && 'bg-white shadow-sm dark:bg-stone-950')}>{f}</button>
          ))}
        </div>
        {me.isLead && <Button kind="primary" className="ml-auto" onClick={() => setAssigning(true)}>+ Assign task</Button>}
      </div>
      {assigning && <AssignForm onDone={() => setAssigning(false)} />}
      <Card className="p-0">{shown.length ? shown.map(t => <Row key={t.id} t={t} />) : <Empty>No tasks here.</Empty>}</Card>
    </div>
  );
}
