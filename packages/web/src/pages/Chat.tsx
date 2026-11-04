import { useEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo, type Message, type Task, type Thread } from '../api.ts';
import { useStore } from '../store.tsx';
import { desktop } from '../desktop.ts';
import { Badge, Button, cx, Diff, Dot, Empty, inputCls, ModeTag } from '../ui.tsx';

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function ApprovalBanner() {
  const { me, tasks, memberName } = useStore();
  const pending = tasks.filter(t => t.toId === me.id && t.status === 'pending_approval');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  if (!pending.length) return null;
  const decide = async (t: Task, approve: boolean) => {
    setBusy(t.id); setError('');
    try {
      // In the app, the approval is recorded on this computer (bound to this exact request) before the team server hears of it.
      if (desktop) await desktop.decideTask(t.id, approve);
      else await api('POST', `/api/tasks/${t.id}/${approve ? 'approve' : 'reject'}`, {});
    } catch (e) { setError(cleanError(e)); }
    setBusy(null);
  };
  return (
    <div role="region" aria-label="Fix requests waiting for your approval" className="space-y-3 border-b border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
      {pending.map(t => (
        <div key={t.id} className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">🔒 {memberName(t.fromId)}'s Claude wants to change code on your computer: fix #{t.id} "{t.title}"</div>
            <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-amber-200 bg-white/70 p-2 text-stone-800 dark:border-amber-500/20 dark:bg-stone-900/60 dark:text-stone-200">{t.prompt}</div>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-stone-600 dark:text-stone-400">
              <li>Your Claude works in separate copies of your projects, on a new branch <code>claude-link/task-{t.id}</code>. Your own checkout and uncommitted work are not touched.</li>
              <li>It may read and edit files in those copies only. It cannot run commands unless you allowed specific ones in your config.</li>
              <li>Nothing is merged or pushed. You review the diff and merge it yourself, if you want it.</li>
              <li>Read the request: approving lets your Claude act on it. If it asks for anything unrelated (secrets, other folders), reject it.</li>
              {!desktop && <li>Your Claude Link agent will ask you to confirm on your computer before it runs.</li>}
            </ul>
          </div>
          <div className="flex gap-2">
            <Button kind="primary" disabled={busy === t.id} onClick={() => decide(t, true)}>Approve and run</Button>
            <Button disabled={busy === t.id} onClick={() => decide(t, false)}>Reject</Button>
          </div>
        </div>
      ))}
      {error && <div role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</div>}
    </div>
  );
}

function ThreadList({ selected, onSelect, onNewRequest }: { selected: number | null; onSelect: (id: number) => void; onNewRequest: () => void }) {
  const { me, threads, members } = useStore();
  const [dmOpen, setDmOpen] = useState(false);
  const label = (t: Thread) => {
    if (t.kind === 'channel') return `# ${t.title}`;
    if (t.kind === 'dm') {
      const others = t.participantIds.filter(id => id !== me.id);
      return others.length === 1 ? (members.find(m => m.id === others[0])?.name ?? t.title) : t.title;
    }
    return t.title;
  };
  const dmOnline = (t: Thread) => members.find(m => m.id === t.participantIds.find(id => id !== me.id))?.online ?? false;
  const section = (kind: Thread['kind'], title: string, extra?: React.ReactNode) => {
    const list = threads.filter(t => t.kind === kind);
    return (
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
          <span>{title}</span>{extra}
        </div>
        {list.length === 0 && <div className="px-2 text-xs text-stone-400">None yet</div>}
        {list.map(t => (
          <button key={t.id} onClick={() => onSelect(t.id)} className={cx(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
            selected === t.id ? 'bg-brand/10 text-brand-dark dark:text-brand' : 'hover:bg-stone-200/60 dark:hover:bg-stone-800')}>
            {kind === 'dm' && <Dot on={dmOnline(t)} />}
            {kind === 'claude' && <span aria-hidden>✳︎</span>}
            <span className={cx('min-w-0 flex-1 truncate', t.unread > 0 && 'font-semibold')}>{label(t)}</span>
            {t.unread > 0 && <span className="rounded-full bg-brand px-1.5 text-xs text-white">{t.unread}</span>}
          </button>
        ))}
      </div>
    );
  };
  const others = members.filter(m => m.id !== me.id);
  return (
    <div className="flex h-full flex-col">
      <div className="p-3"><Button kind="primary" className="w-full" onClick={onNewRequest}>✳︎ Ask a teammate's Claude</Button></div>
      <div className="flex-1 overflow-y-auto px-2">
        {section('channel', 'Channels')}
        {section('dm', 'Direct messages', <button className="text-base leading-none hover:text-brand" title="New message" onClick={() => setDmOpen(o => !o)}>+</button>)}
        {dmOpen && (
          <div className="mb-4 space-y-1 px-2">
            {others.map(m => (
              <button key={m.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-stone-200/60 dark:hover:bg-stone-800"
                onClick={async () => { const t = await api<Thread>('POST', '/api/threads/dm', { memberId: m.id }); setDmOpen(false); onSelect(t.id); }}>
                <Dot on={m.online} />{m.name}
              </button>
            ))}
          </div>
        )}
        {section('claude', 'Claude conversations')}
      </div>
    </div>
  );
}

function MessageView({ m, tasks }: { m: Message; tasks: Task[] }) {
  const { me, memberName, members } = useStore();
  const [showDiff, setShowDiff] = useState(false);
  const taskId = typeof m.meta?.taskId === 'number' ? m.meta.taskId : null;
  const task = taskId ? tasks.find(t => t.id === taskId) : undefined;

  if (m.authorKind === 'system') {
    return <div className="my-2 text-center text-xs text-stone-500 whitespace-pre-wrap">{m.body}</div>;
  }
  const isClaude = m.authorKind === 'claude';
  const mine = m.authorId === me.id;
  const role = members.find(x => x.id === m.authorId)?.role;
  return (
    <div className={cx('my-3 flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[85%] rounded-2xl px-4 py-2.5',
        mine ? 'bg-brand/10 dark:bg-brand/15' : 'bg-white border border-stone-200 dark:bg-stone-900 dark:border-stone-800')}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <span className="font-semibold text-stone-800 dark:text-stone-200">{memberName(m.authorId)}{isClaude && "'s Claude"}</span>
          {isClaude && <span className="rounded bg-brand/15 px-1 text-[10px] font-semibold uppercase text-brand-dark dark:text-brand">Claude</span>}
          {role && <span>{role}</span>}
          <span>{timeAgo(m.createdAt)}</span>
          {task && m.meta?.mode !== undefined && <><ModeTag mode={task.mode} /><Badge value={task.status} /></>}
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
        {task?.status === 'running' && m.meta?.mode !== undefined && task.result && (
          <div className="mt-2 text-xs text-sky-700 dark:text-sky-300">⏳ {task.result}</div>
        )}
        {task?.diff && m.meta?.hasDiff === true && (
          <div className="mt-2">
            <button className="text-xs font-medium text-brand hover:underline" onClick={() => setShowDiff(s => !s)}>
              {showDiff ? 'Hide diff' : `View diff (${task.branch})`}
            </button>
            {showDiff && <div className="mt-2"><Diff diff={task.diff} /></div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ thread }: { thread: Thread }) {
  const { me, members } = useStore();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'read' | 'fix'>('read');
  const [busy, setBusy] = useState(false);
  const isParticipant = thread.participantIds.includes(me.id);
  const other = thread.kind === 'claude' ? members.find(m => m.id === thread.participantIds.find(id => id !== me.id)) : undefined;
  const [error, setError] = useState('');
  const modes = me.access === 'viewer' ? (['read'] as const) : (['read', 'fix'] as const);

  if (thread.kind === 'claude' && !isParticipant) {
    return <div className="border-t border-stone-200 p-3 text-center text-xs text-stone-500 dark:border-stone-800">You are viewing this conversation as the team lead (read-only).</div>;
  }
  if (thread.kind === 'dm' && !isParticipant) {
    return <div className="border-t border-stone-200 p-3 text-center text-xs text-stone-500 dark:border-stone-800">Private conversation between teammates (read-only).</div>;
  }

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      if (thread.kind === 'claude') await api('POST', '/api/tasks', { toId: other!.id, mode, prompt: text, threadId: thread.id });
      else await api('POST', `/api/threads/${thread.id}/messages`, { body: text });
      setText('');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="border-t border-stone-200 p-3 dark:border-stone-800">
      {thread.kind === 'claude' && other && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-stone-500">Follow up with {other.name}'s Claude:</span>
          {modes.map(m => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={cx('rounded-full px-2 py-0.5', mode === m ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'bg-stone-200 dark:bg-stone-800')}>
              {m === 'read' ? 'Question (read-only)' : 'Fix (needs approval)'}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <textarea aria-label="Message" maxLength={20000} className={cx(inputCls, 'min-h-[42px] resize-none')} rows={Math.min(6, text.split('\n').length)} value={text}
          placeholder={thread.kind === 'claude' ? `Ask ${other?.name}'s Claude…` : 'Message…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <Button kind="primary" disabled={busy || !text.trim()} onClick={send}>Send</Button>
      </div>
      {error && <div role="alert" className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

function NewRequest({ onCreated, onCancel }: { onCreated: (threadId: number) => void; onCancel: () => void }) {
  const { me, members } = useStore();
  const others = members.filter(m => m.id !== me.id);
  const [toId, setToId] = useState<number>(others[0]?.id ?? 0);
  const [mode, setMode] = useState<'read' | 'fix'>('read');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = others.find(m => m.id === toId);
  const modes = me.access === 'viewer' ? (['read'] as const) : (['read', 'fix'] as const);
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Ask a teammate's Claude</h2>
      <p className="mt-1 text-sm text-stone-500">Their Claude Code works in their repository and replies here. Questions run automatically with read-only access; fixes wait for the owner's approval.</p>
      <div className="mt-5 space-y-4">
        <label className="block text-sm font-medium">Teammate
          <select className={cx(inputCls, 'mt-1')} value={toId} onChange={e => setToId(Number(e.target.value))}>
            {others.map(m => <option key={m.id} value={m.id}>{m.name} — {m.role}{m.online ? '' : ' (offline)'}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          {modes.map(m => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={cx('flex-1 rounded-lg border p-3 text-left text-sm',
              mode === m ? 'border-brand bg-brand/5' : 'border-stone-300 dark:border-stone-700')}>
              <div className="font-medium">{m === 'read' ? 'Question' : 'Fix / change'}</div>
              <div className="text-xs text-stone-500">{m === 'read' ? 'Read-only, answered automatically' : 'Edits on a new branch after approval'}</div>
            </button>
          ))}
        </div>
        <label className="block text-sm font-medium">Request
          <textarea className={cx(inputCls, 'mt-1')} rows={6} maxLength={20000} value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder={mode === 'read' ? 'e.g. What does POST /api/orders return when the cart is empty?' : 'e.g. The login form crashes when email is empty; add validation in LoginForm.tsx'} />
        </label>
        {target && !target.online && <div className="text-xs text-amber-600">{target.name}'s agent is offline. The request will run when they reconnect.</div>}
        {me.access === 'viewer' && <div className="text-xs text-stone-500">Your access level (viewer) lets you ask questions but not request code changes.</div>}
        {error && <div role="alert" className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button kind="primary" disabled={busy || !prompt.trim() || !toId} onClick={async () => {
            setBusy(true);
            setError('');
            try { const t = await api<Task>('POST', '/api/tasks', { toId, mode, prompt }); onCreated(t.threadId!); }
            catch (e) { setError((e as Error).message); setBusy(false); }
          }}>Send request</Button>
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { threads, messages, loadMessages, markRead, tasks, me } = useStore();
  const [selected, setSelected] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const autoSelected = useRef(false);
  const thread = threads.find(t => t.id === selected) ?? null;
  const list = selected ? messages[selected] : undefined;

  useEffect(() => {
    // Open #team once on wide screens; on phones the thread list is the landing view.
    if (autoSelected.current || !threads.length) return;
    autoSelected.current = true;
    if (window.matchMedia('(min-width: 768px)').matches) setSelected(threads.find(t => t.kind === 'channel')?.id ?? threads[0]!.id);
  }, [threads]);

  useEffect(() => { if (selected) void loadMessages(selected); }, [selected, loadMessages]);

  // Mark read whenever new messages arrive in the open thread.
  const count = list?.length ?? 0;
  useEffect(() => {
    if (!thread || !count) return;
    bottom.current?.scrollIntoView({ block: 'end' });
    if (thread.unread > 0 && (thread.kind === 'channel' || thread.participantIds.includes(me.id))) {
      markRead(thread.id);
    }
  }, [count, thread?.id, thread?.unread]); // eslint-disable-line react-hooks/exhaustive-deps

  const participantsLabel = useMemo(() => thread?.kind === 'claude' ? 'Claude-to-Claude conversation' : thread?.kind === 'channel' ? 'Everyone on the team' : 'Direct message', [thread]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className={cx('w-72 shrink-0 border-r border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/40', 'max-md:w-full', (thread || composing) && 'max-md:hidden')}>
          <ThreadList selected={composing ? null : selected} onSelect={id => { setComposing(false); setSelected(id); }} onNewRequest={() => setComposing(true)} />
        </aside>
        <section className={cx('flex min-w-0 flex-1 flex-col', !(thread || composing) && 'max-md:hidden')}>
          {composing ? (
            <div className="overflow-y-auto">
              <NewRequest onCancel={() => setComposing(false)} onCreated={id => { setComposing(false); setSelected(id); }} />
            </div>
          ) : thread ? (
            <>
              <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                <button className="md:hidden" onClick={() => setSelected(null)}>←</button>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{thread.kind === 'channel' ? `# ${thread.title}` : thread.title}</div>
                  <div className="text-xs text-stone-500">{participantsLabel}</div>
                </div>
              </header>
              <div className="flex-1 overflow-y-auto px-4">
                {!list ? <Empty>Loading…</Empty> : list.length === 0 ? <Empty>No messages yet. Say hello 👋</Empty> :
                  list.map(m => <MessageView key={m.id} m={m} tasks={tasks} />)}
                <div ref={bottom} />
              </div>
              <Composer thread={thread} />
            </>
          ) : <Empty>Select a conversation</Empty>}
        </section>
      </div>
    </div>
  );
}
