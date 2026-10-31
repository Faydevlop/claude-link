import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { Db } from './db.ts';
import {
  createMemberBody, createTaskBody, gitStateBody, openDmBody, postMessageBody, statusBody, taskCompleteBody,
  taskProgressBody, updateMemberBody, updateTaskBody,
  type HubEvent, type Member, type Role, type Task, type Thread,
} from '../../shared/src/index.ts';

export const newToken = () => 'cl_' + randomBytes(24).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface HubOptions {
  dbPath: string;
  webDir?: string;
  logger?: boolean;
}

interface Conn { ws: WebSocket; memberId: number; kind: 'agent' | 'web' }

declare module 'fastify' {
  interface FastifyRequest { member: Member }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const idParam = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) fail(400, 'invalid id');
  return id;
};
const body = <T extends z.ZodType>(schema: T, req: FastifyRequest): z.infer<T> => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) fail(400, r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data as z.infer<T>;
};

export function buildHub(opts: HubOptions) {
  const db = new Db(opts.dbPath);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const conns = new Set<Conn>();

  if (!db.teamChannel()) db.createThread('channel', 'team', null, []);

  // ---- realtime fan-out ----

  const send = (c: Conn, e: HubEvent) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(e)); };

  const emit = (e: HubEvent, canSee: (viewer: Member) => boolean) => {
    for (const c of conns) {
      const viewer = db.member(c.memberId);
      if (viewer && canSee(viewer)) send(c, e);
    }
  };
  const emitMember = (m: Member) => emit({ type: 'member.updated', member: m }, () => true);
  const emitThread = (t: Thread) => {
    for (const c of conns) {
      const viewer = db.member(c.memberId);
      if (viewer && db.canSeeThread(viewer, t)) send(c, { type: 'thread.updated', thread: db.thread(t.id, viewer.id)! });
    }
  };
  const emitTask = (t: Task) => emit({ type: 'task.updated', task: t }, v => v.isLead || v.id === t.fromId || v.id === t.toId);

  const postMessage = (threadId: number, authorId: number | null, kind: 'human' | 'claude' | 'system', text: string, meta: Record<string, unknown> | null = null) => {
    const msg = db.addMessage(threadId, authorId, kind, text, meta);
    const thread = db.thread(threadId, 0)!;
    emit({ type: 'message.created', message: msg }, v => db.canSeeThread(v, thread));
    emitThread(thread);
    return msg;
  };

  /** Hand a queued task to the target's agent, if it is connected. */
  const dispatch = (task: Task) => {
    const agent = [...conns].find(c => c.kind === 'agent' && c.memberId === task.toId);
    const requester = db.member(task.fromId);
    if (!agent || !requester) return;
    const resumeSessionId = task.mode === 'read' && task.threadId ? db.claudeSession(task.threadId, task.toId) : null;
    send(agent, { type: 'task.run', task, requester: { id: requester.id, name: requester.name, role: requester.role }, resumeSessionId });
  };

  const dmThread = (a: Member, b: Member) => {
    const key = [a.id, b.id].sort((x, y) => x - y).join(':');
    return db.threadByDmKey(key, a.id) ?? db.createThread('dm', `${a.name} & ${b.name}`, a.id, [a.id, b.id], key);
  };

  // ---- auth ----

  const authenticate = (token: string | undefined): Member | null => {
    if (!token) return null;
    const m = db.memberByTokenHash(hashToken(token));
    if (m) db.touch(m.id);
    return m;
  };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/ws')) return;
    if (req.url === '/api/health') return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string }).token;
    const member = authenticate(token);
    if (!member) return reply.status(401).send({ error: 'invalid or missing token' });
    req.member = member;
  });

  const requireLead = (req: FastifyRequest) => { if (!req.member.isLead) fail(403, 'team lead only'); };
  const viaClaude = (req: FastifyRequest) => req.headers['x-claude-link-client'] === 'mcp';

  app.register(websocket);
  app.register(async scoped => {
    scoped.get('/ws', { websocket: true }, (ws, req) => {
      const kind = (req.query as { client?: string }).client === 'agent' ? 'agent' : 'web';
      const conn: Conn = { ws, memberId: req.member.id, kind };
      conns.add(conn);
      if (kind === 'agent') {
        db.online.add(conn.memberId);
        db.audit(conn.memberId, 'agent.connected', null);
        emitMember(db.member(conn.memberId)!);
        for (const t of db.runnableTasks(conn.memberId)) dispatch(t);
      }
      send(conn, { type: 'hello', me: db.member(conn.memberId)! });
      ws.on('close', () => {
        conns.delete(conn);
        if (kind === 'agent' && ![...conns].some(c => c.kind === 'agent' && c.memberId === conn.memberId)) {
          db.online.delete(conn.memberId);
          db.audit(conn.memberId, 'agent.disconnected', null);
          const m = db.member(conn.memberId);
          if (m) emitMember(m);
        }
      });
      // Clients only listen; ignore anything they send apart from keepalives.
      ws.on('message', () => {});
    });
  });

  // ---- routes ----

  app.get('/api/health', async () => ({ ok: true, name: 'claude-link' }));

  app.get('/api/me', async req => db.member(req.member.id));

  app.get('/api/members', async () => db.members());

  app.post('/api/members', async req => {
    requireLead(req);
    const { name, role } = body(createMemberBody, req);
    if (db.members().some(m => m.name.toLowerCase() === name.toLowerCase())) fail(409, 'a member with that name exists');
    const token = newToken();
    const member = db.createMember(name, role as Role, false, hashToken(token));
    db.audit(req.member.id, 'member.created', `member:${member.id}`, { name, role });
    emitMember(member);
    return { member, token };
  });

  app.patch('/api/members/:id', async req => {
    requireLead(req);
    const id = idParam(req);
    if (!db.member(id)) fail(404, 'no such member');
    const member = db.updateMember(id, body(updateMemberBody, req))!;
    db.audit(req.member.id, 'member.updated', `member:${id}`);
    emitMember(member);
    return member;
  });

  app.post('/api/members/:id/token', async req => {
    requireLead(req);
    const id = idParam(req);
    if (!db.member(id)) fail(404, 'no such member');
    const token = newToken();
    db.setTokenHash(id, hashToken(token));
    for (const c of conns) if (c.memberId === id) c.ws.close(4001, 'token rotated');
    db.audit(req.member.id, 'member.token_rotated', `member:${id}`);
    return { token };
  });

  app.delete('/api/members/:id', async req => {
    requireLead(req);
    const id = idParam(req);
    const m = db.member(id) ?? fail(404, 'no such member');
    if (m.isLead) fail(400, 'cannot remove the lead');
    for (const c of conns) if (c.memberId === id) c.ws.close(4001, 'removed');
    db.deleteMember(id);
    db.online.delete(id);
    db.audit(req.member.id, 'member.removed', `member:${id}`, { name: m.name });
    emit({ type: 'member.removed', memberId: id }, () => true);
    return { ok: true };
  });

  // Status board is lead-only; members only report.
  app.get('/api/status', async req => {
    requireLead(req);
    return { members: db.members(), statuses: db.latestStatuses() };
  });

  app.get('/api/status/:id/history', async req => {
    requireLead(req);
    return db.statusHistory(idParam(req));
  });

  app.post('/api/status', async req => {
    const b = body(statusBody, req);
    const status = db.addStatus(req.member.id, b.state, b.summary, b.taskId ?? null);
    emit({ type: 'status.updated', status }, v => v.isLead || v.id === req.member.id);
    return status;
  });

  app.post('/api/status/git', async req => {
    const b = body(gitStateBody, req);
    db.setGit(req.member.id, { branch: b.branch, dirtyFiles: b.dirtyFiles, recentCommits: b.recentCommits }, b.repoPath);
    emitMember(db.member(req.member.id)!);
    return { ok: true };
  });

  app.get('/api/threads', async req => db.threadsFor(req.member));

  app.post('/api/threads/dm', async req => {
    const { memberId } = body(openDmBody, req);
    const other = db.member(memberId) ?? fail(404, 'no such member');
    if (other.id === req.member.id) fail(400, 'cannot DM yourself');
    return dmThread(req.member, other);
  });

  const visibleThread = (req: FastifyRequest) => {
    const t = db.thread(idParam(req), req.member.id) ?? fail(404, 'no such thread');
    if (!db.canSeeThread(req.member, t)) fail(404, 'no such thread');
    return t;
  };

  app.get('/api/threads/:id/messages', async req => {
    const t = visibleThread(req);
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return { thread: t, messages: db.messages(t.id, after) };
  });

  app.post('/api/threads/:id/read', async req => {
    const t = visibleThread(req);
    if (t.kind === 'channel' || t.participantIds.includes(req.member.id)) db.markRead(t.id, req.member.id);
    return { ok: true };
  });

  app.post('/api/threads/:id/messages', async req => {
    const t = visibleThread(req);
    // Claude-to-Claude threads are written by tasks; humans follow up by asking again.
    if (t.kind === 'claude') fail(400, 'use a task to continue a Claude conversation');
    if (t.kind === 'dm' && !t.participantIds.includes(req.member.id)) fail(403, 'not your conversation');
    const { body: text } = body(postMessageBody, req);
    const msg = postMessage(t.id, req.member.id, viaClaude(req) ? 'claude' : 'human', text);
    db.markRead(t.id, req.member.id);
    return msg;
  });

  app.get('/api/inbox', async req => {
    const unread = db.unreadMessages(req.member);
    const approvals = db.tasksFor(req.member).filter(t => t.toId === req.member.id && t.status === 'pending_approval');
    const assignments = db.tasksFor(req.member).filter(t => t.toId === req.member.id && t.mode === 'assignment' && t.status !== 'done');
    return { unread, approvals, assignments };
  });

  app.post('/api/inbox/read', async req => {
    for (const { thread } of db.unreadMessages(req.member)) db.markRead(thread.id, req.member.id);
    return { ok: true };
  });

  // ---- tasks ----

  app.get('/api/tasks', async req => db.tasksFor(req.member));

  const visibleTask = (req: FastifyRequest) => {
    const t = db.task(idParam(req)) ?? fail(404, 'no such task');
    if (!req.member.isLead && t.fromId !== req.member.id && t.toId !== req.member.id) fail(404, 'no such task');
    return t;
  };

  app.get('/api/tasks/:id', async req => visibleTask(req));

  app.post('/api/tasks', async req => {
    const b = body(createTaskBody, req);
    const from = req.member;
    const to = db.member(b.toId) ?? fail(404, 'no such member');
    if (to.id === from.id) fail(400, 'cannot send a task to yourself');
    const title = b.title ?? b.prompt.split('\n')[0]!.slice(0, 80);

    if (b.mode === 'assignment') {
      requireLead(req);
      const task = db.createTask({ fromId: from.id, toId: to.id, mode: 'assignment', status: 'open', title, prompt: b.prompt, threadId: null });
      const dm = dmThread(from, to);
      postMessage(dm.id, null, 'system', `📋 ${from.name} assigned task #${task.id} to ${to.name}: ${title}\n\n${b.prompt}`, { taskId: task.id });
      db.audit(from.id, 'task.assigned', `task:${task.id}`, { to: to.id });
      emitTask(task);
      return task;
    }

    let thread: Thread;
    if (b.threadId) {
      thread = db.thread(b.threadId, from.id) ?? fail(404, 'no such thread');
      if (thread.kind !== 'claude' || !thread.participantIds.includes(from.id) || !thread.participantIds.includes(to.id)) {
        fail(400, 'thread is not a Claude conversation between you and that member');
      }
    } else {
      thread = db.createThread('claude', `${from.name} ↔ ${to.name}: ${title}`, from.id, [from.id, to.id]);
    }

    const status = b.mode === 'fix' ? 'pending_approval' : 'queued';
    const task = db.createTask({ fromId: from.id, toId: to.id, mode: b.mode, status, title, prompt: b.prompt, threadId: thread.id });
    postMessage(thread.id, from.id, viaClaude(req) ? 'claude' : 'human', b.prompt, { taskId: task.id, mode: b.mode });
    if (status === 'pending_approval') {
      postMessage(thread.id, null, 'system', `🔒 Fix request #${task.id} is waiting for ${to.name} to approve it.`, { taskId: task.id });
    } else if (!db.online.has(to.id)) {
      postMessage(thread.id, null, 'system', `${to.name}'s agent is offline. The question will run when it reconnects.`, { taskId: task.id });
    }
    db.audit(from.id, 'task.created', `task:${task.id}`, { to: to.id, mode: b.mode });
    emitTask(task);
    if (status === 'queued') dispatch(task);
    return task;
  });

  const decide = (approve: boolean) => async (req: FastifyRequest) => {
    const t = visibleTask(req);
    if (t.toId !== req.member.id) fail(403, 'only the owner of the target machine can decide');
    if (t.status !== 'pending_approval') fail(409, `task is ${t.status}`);
    const task = db.updateTask(t.id, { status: approve ? 'queued' : 'rejected' });
    db.audit(req.member.id, approve ? 'task.approved' : 'task.rejected', `task:${t.id}`);
    if (task.threadId) {
      postMessage(task.threadId, null, 'system', approve
        ? `✅ ${req.member.name} approved fix #${t.id}.`
        : `⛔ ${req.member.name} rejected fix #${t.id}.`, { taskId: t.id });
    }
    emitTask(task);
    if (approve) dispatch(task);
    return task;
  };
  app.post('/api/tasks/:id/approve', decide(true));
  app.post('/api/tasks/:id/reject', decide(false));

  // Assignment tracking by the assignee (or the lead).
  app.patch('/api/tasks/:id', async req => {
    const t = visibleTask(req);
    if (t.mode !== 'assignment') fail(400, 'only assignments can be updated by hand');
    if (t.toId !== req.member.id && !req.member.isLead) fail(403, 'not your task');
    const b = body(updateTaskBody, req);
    const task = db.updateTask(t.id, { status: b.status, result: b.note });
    const lead = db.member(t.fromId);
    if (lead) {
      const dm = dmThread(req.member, lead.id === req.member.id ? db.member(t.toId)! : lead);
      postMessage(dm.id, null, 'system', `📋 Task #${t.id} "${t.title}" → ${task.status}${b.note ? `\n\n${b.note}` : ''}`, { taskId: t.id });
    }
    db.audit(req.member.id, 'task.updated', `task:${t.id}`, { status: b.status });
    emitTask(task);
    return task;
  });

  // Agent callbacks.
  const ownTask = (req: FastifyRequest) => {
    const t = db.task(idParam(req)) ?? fail(404, 'no such task');
    if (t.toId !== req.member.id) fail(403, 'not your task');
    return t;
  };

  app.post('/api/tasks/:id/progress', async req => {
    const t = ownTask(req);
    const { text } = body(taskProgressBody, req);
    if (t.status !== 'queued' && t.status !== 'running') fail(409, `task is ${t.status}`);
    const task = db.updateTask(t.id, { status: 'running', result: text });
    emitTask(task);
    return { ok: true };
  });

  app.post('/api/tasks/:id/complete', async req => {
    const t = ownTask(req);
    if (t.status !== 'queued' && t.status !== 'running') fail(409, `task is ${t.status}`);
    const b = body(taskCompleteBody, req);
    const task = db.updateTask(t.id, { status: b.ok ? 'done' : 'failed', result: b.result, diff: b.diff ?? null, branch: b.branch ?? null });
    if (t.threadId && b.sessionId && t.mode === 'read') db.setClaudeSession(t.threadId, req.member.id, b.sessionId);
    if (t.threadId) {
      const suffix = b.branch ? `\n\n🌿 Changes committed on branch \`${b.branch}\`${b.diff ? ' (diff attached to the task)' : ''}.` : '';
      postMessage(t.threadId, req.member.id, b.ok ? 'claude' : 'system', (b.ok ? '' : `❌ Task #${t.id} failed: `) + b.result + suffix,
        { taskId: t.id, branch: b.branch ?? null, hasDiff: !!b.diff });
    }
    db.audit(req.member.id, b.ok ? 'task.done' : 'task.failed', `task:${t.id}`, { branch: b.branch ?? null });
    emitTask(task);
    return task;
  });

  app.get('/api/audit', async req => {
    requireLead(req);
    return db.auditLog();
  });

  // ---- web app ----

  if (opts.webDir && existsSync(opts.webDir)) {
    app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}

/** Creates the lead account on first run. Returns the token only when one was just created. */
export function ensureLead(db: Db, name: string): { lead: Member; token: string | null } {
  const existing = db.lead();
  if (existing) return { lead: existing, token: null };
  const token = newToken();
  const lead = db.createMember(name, 'lead', true, hashToken(token));
  db.audit(lead.id, 'hub.initialized', null);
  return { lead, token };
}

export function rotateLeadToken(db: Db): string {
  const lead = db.lead() ?? fail(500, 'no lead');
  const token = newToken();
  db.setTokenHash(lead.id, hashToken(token));
  return token;
}
