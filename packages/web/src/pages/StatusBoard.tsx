import { timeAgo } from '../api.ts';
import { useStore } from '../store.tsx';
import { Badge, Card, Dot, Empty, ModeTag, ROLE_LABEL } from '../ui.tsx';

export default function StatusBoard() {
  const { members, statuses, tasks, memberName } = useStore();
  const active = tasks.filter(t => ['pending_approval', 'queued', 'running', 'open', 'in_progress', 'blocked'].includes(t.status));
  if (!members.length) return <Empty>Loading…</Empty>;
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Team status</h1>
        <span className="text-sm text-stone-500">{members.filter(m => m.online).length} of {members.length} agents online</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {members.map(m => {
          const s = statuses.find(x => x.memberId === m.id);
          const mine = active.filter(t => t.toId === m.id);
          return (
            <Card key={m.id} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Dot on={m.online} />
                <span className="font-semibold">{m.name}</span>
                <span className="text-xs text-stone-500">{ROLE_LABEL[m.role]}</span>
                <span className="ml-auto text-xs text-stone-400">seen {timeAgo(m.lastSeen)}</span>
              </div>
              {s ? (
                <div>
                  <div className="flex items-center gap-2"><Badge value={s.state} /><span className="text-xs text-stone-500">{timeAgo(s.createdAt)}</span></div>
                  <p className="mt-1.5 text-sm whitespace-pre-wrap">{s.summary}</p>
                </div>
              ) : <p className="text-sm text-stone-400">No status reported yet.</p>}
              {m.git && (
                <div className="rounded-lg bg-stone-50 p-2.5 text-xs dark:bg-stone-950">
                  <div className="flex justify-between font-mono">
                    <span className="truncate">⎇ {m.git.branch}</span>
                    <span className={m.git.dirtyFiles.length ? 'text-amber-600' : 'text-stone-400'}>{m.git.dirtyFiles.length} uncommitted</span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {m.git.recentCommits.slice(0, 4).map(c => (
                      <li key={c.hash} className="flex gap-2"><span className="font-mono text-stone-400">{c.hash}</span><span className="truncate">{c.subject}</span><span className="ml-auto shrink-0 text-stone-400">{timeAgo(c.at)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {mine.length > 0 && (
                <ul className="space-y-1 border-t border-stone-100 pt-2 text-xs dark:border-stone-800">
                  {mine.map(t => (
                    <li key={t.id} className="flex items-center gap-2">
                      <ModeTag mode={t.mode} /><span className="min-w-0 flex-1 truncate">#{t.id} {t.title}</span>
                      <span className="text-stone-400">from {memberName(t.fromId)}</span><Badge value={t.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
