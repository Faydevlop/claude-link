import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, getToken, hubWsUrl, type HubEvent, type JoinRequest, type Member, type Message, type StatusUpdate, type Task, type Thread } from './api.ts';

interface State {
  me: Member;
  members: Member[];
  threads: Thread[];
  tasks: Task[];
  statuses: StatusUpdate[];
  messages: Record<number, Message[]>;
  joinRequests: JoinRequest[];
  connected: boolean;
}

interface Store extends State {
  memberName: (id: number | null) => string;
  loadMessages: (threadId: number) => Promise<void>;
  markRead: (threadId: number) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => useContext(Ctx)!;

const upsert = <T extends { id: number }>(list: T[], item: T) => {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
};

export function StoreProvider({ me, children }: { me: Member; children: ReactNode }) {
  const [state, setState] = useState<State>({ me, members: [], threads: [], tasks: [], statuses: [], messages: {}, joinRequests: [], connected: false });
  const loaded = useRef(new Set<number>());

  const refresh = useCallback(async () => {
    const [members, threads, tasks, status, joinRequests] = await Promise.all([
      api<Member[]>('GET', '/api/members'),
      api<Thread[]>('GET', '/api/threads'),
      api<Task[]>('GET', '/api/tasks'),
      me.isLead ? api<{ statuses: StatusUpdate[] }>('GET', '/api/status') : Promise.resolve({ statuses: [] }),
      me.isLead ? api<JoinRequest[]>('GET', '/api/join-requests') : Promise.resolve([] as JoinRequest[]),
    ]);
    setState(s => ({ ...s, members, threads, tasks, statuses: status.statuses, joinRequests }));
  }, [me.isLead]);

  const loadMessages = useCallback(async (threadId: number) => {
    const { messages } = await api<{ messages: Message[] }>('GET', `/api/threads/${threadId}/messages`);
    loaded.current.add(threadId);
    setState(s => ({ ...s, messages: { ...s.messages, [threadId]: messages } }));
  }, []);

  useEffect(() => {
    void refresh();
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(hubWsUrl(`/ws?client=web&token=${encodeURIComponent(getToken() ?? '')}`));
      ws.onopen = () => { setState(s => ({ ...s, connected: true })); void refresh(); };
      ws.onclose = () => {
        setState(s => ({ ...s, connected: false }));
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = e => {
        const ev = JSON.parse(e.data) as HubEvent;
        setState(s => {
          switch (ev.type) {
            case 'member.updated': return { ...s, members: upsert(s.members, ev.member), me: ev.member.id === s.me.id ? ev.member : s.me };
            case 'member.removed': return { ...s, members: s.members.filter(m => m.id !== ev.memberId) };
            case 'status.updated': return { ...s, statuses: [ev.status, ...s.statuses.filter(x => x.memberId !== ev.status.memberId)] };
            case 'thread.updated': return { ...s, threads: upsert(s.threads, ev.thread) };
            case 'joinRequest.updated': return { ...s, joinRequests: upsert(s.joinRequests, ev.request) };
            case 'task.updated': return { ...s, tasks: upsert(s.tasks, ev.task).sort((a, b) => b.id - a.id) };
            case 'message.created': {
              if (!loaded.current.has(ev.message.threadId)) return s;
              const list = s.messages[ev.message.threadId] ?? [];
              if (list.some(m => m.id === ev.message.id)) return s;
              return { ...s, messages: { ...s.messages, [ev.message.threadId]: [...list, ev.message] } };
            }
            default: return s;
          }
        });
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); ws.close(); };
  }, [refresh]);

  const markRead = useCallback((threadId: number) => {
    setState(s => ({ ...s, threads: s.threads.map(t => t.id === threadId ? { ...t, unread: 0 } : t) }));
    void api('POST', `/api/threads/${threadId}/read`).catch(() => {});
  }, []);

  const memberName = useCallback((id: number | null) => state.members.find(m => m.id === id)?.name ?? 'Unknown', [state.members]);

  return <Ctx.Provider value={{ ...state, memberName, loadMessages, markRead, refresh }}>{children}</Ctx.Provider>;
}
