import { useEffect, useState } from 'react';
import { api, timeAgo, type AuditEntry } from '../api.ts';
import { useStore } from '../store.tsx';
import { Button, Card, Empty, inputCls } from '../ui.tsx';

const PAGE = 200;

const describeMeta = (meta: Record<string, unknown> | null) =>
  meta ? Object.entries(meta).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? (k === 'approvalHash' ? v.slice(0, 12) + '…' : v) : JSON.stringify(v)}`).join(' · ') : '';

export default function Audit() {
  const { memberName, tasks } = useStore();
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  // Refetch when task activity changes, since most audit entries come from tasks.
  const stamp = tasks.map(t => t.updatedAt).join();

  useEffect(() => {
    const t = setTimeout(() => {
      api<AuditEntry[]>('GET', `/api/audit?limit=${PAGE}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
        .then(l => { setLog(l); setMore(l.length === PAGE); setError(''); })
        .catch(e => { setLog([]); setError((e as Error).message); });
    }, 250);
    return () => clearTimeout(t);
  }, [stamp, q]);

  const loadMore = async () => {
    if (!log?.length) return;
    const next = await api<AuditEntry[]>('GET', `/api/audit?limit=${PAGE}&before=${log.at(-1)!.id}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
    setLog([...log, ...next]);
    setMore(next.length === PAGE);
  };

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <input aria-label="Search the audit log" className={inputCls + ' ml-auto max-w-xs'} placeholder="Search: task:12, approved, join…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <p className="mb-3 text-xs text-stone-500">Every join, connection, request, approval and result, kept on the lead's computer. Approvals record who approved and a fingerprint of the exact request.</p>
      {error && <div role="alert" className="mb-3 text-sm text-red-600">{error}</div>}
      <Card className="p-0">
        {!log ? <Empty>Loading…</Empty> : !log.length ? <Empty>{q ? 'No matching entries.' : 'Nothing yet.'}</Empty> : log.map(e => (
          <div key={e.id} className="grid grid-cols-[5rem_8rem_1fr] gap-3 border-b border-stone-100 px-4 py-2 text-sm last:border-0 max-sm:grid-cols-1 max-sm:gap-0 dark:border-stone-800">
            <span className="text-xs text-stone-400" title={new Date(e.createdAt).toLocaleString()}>{timeAgo(e.createdAt)}</span>
            <span className="truncate font-medium">{e.actorId ? memberName(e.actorId) : 'system'}</span>
            <span className="min-w-0">
              <code className="text-xs">{e.action}</code>
              {e.target && <span className="ml-2 text-xs text-stone-500">{e.target}</span>}
              {e.meta && <span className="block truncate text-xs text-stone-400" title={describeMeta(e.meta)}>{describeMeta(e.meta)}</span>}
            </span>
          </div>
        ))}
      </Card>
      {more && <div className="mt-3 text-center"><Button onClick={() => void loadMore()}>Load older entries</Button></div>}
    </div>
  );
}
