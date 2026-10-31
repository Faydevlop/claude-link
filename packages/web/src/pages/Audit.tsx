import { useEffect, useState } from 'react';
import { api, timeAgo, type AuditEntry } from '../api.ts';
import { useStore } from '../store.tsx';
import { Card, Empty } from '../ui.tsx';

export default function Audit() {
  const { memberName, tasks } = useStore();
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  // Refetch when task activity changes, since most audit entries come from tasks.
  const stamp = tasks.map(t => t.updatedAt).join();
  useEffect(() => { api<AuditEntry[]>('GET', '/api/audit').then(setLog).catch(() => setLog([])); }, [stamp]);
  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <h1 className="mb-4 text-xl font-semibold">Audit log</h1>
      <Card className="p-0">
        {!log ? <Empty>Loading…</Empty> : !log.length ? <Empty>Nothing yet.</Empty> : log.map(e => (
          <div key={e.id} className="flex gap-3 border-b border-stone-100 px-4 py-2 text-sm last:border-0 dark:border-stone-800">
            <span className="w-20 shrink-0 text-xs text-stone-400">{timeAgo(e.createdAt)}</span>
            <span className="w-28 shrink-0 truncate font-medium">{e.actorId ? memberName(e.actorId) : 'system'}</span>
            <code className="text-xs">{e.action}</code>
            <span className="truncate text-xs text-stone-500">{e.target}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
