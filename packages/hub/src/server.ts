import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { Db } from './db.ts';
import { RateLimiter } from './rateLimit.ts';
import { verificationCode, type HubTls } from './tls.ts';
import { taskApprovalHash } from '../../shared/src/approval.ts';
import {
  claimTaskBody, createMemberBody, createTaskBody, gitStateBody, joinRequestBody, openDmBody, postMessageBody, statusBody,
  taskCompleteBody, taskProgressBody, teamSettingsBody, updateMemberBody, updateTaskBody,
  type HubEvent, type JoinRequest, type Member, type Role, type Task, type TaskStatus, type Thread,
} from '../../shared/src/index.ts';

export const newToken = () => 'cl_' + randomBytes(24).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const HUB_VERSION = '0.3.0';

const DEFAULT_TOKEN_IDLE_DAYS = 30;
const JOIN_REQUEST_TTL_MINUTES = 30;
const WS_TICKET_TTL_MS = 60_000;
const HEARTBEAT_MS = 30_000;

// The lead's own agent connects over loopback; show the LAN address teammates would use instead.
const clientIp = (raw: string | undefined) => {
  const ip = (raw ?? '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') {
    return Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address ?? ip;
  }
  return ip || 'unknown';
};

/** Strips credentials from URLs before they can reach a log line. */
export const redactUrl = (url: string) => url.replace(/([?&](?:token|secret|ticket)=)[^&]*/gi, '$1[redacted]');

const safeEqualHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface HubOptions {
  dbPath: string;
  webDir?: string;
  logger?: boolean;
  /** When set, the hub speaks only HTTPS/WSS with this certificate; plain HTTP gets a redirect or an upgrade hint. */
  tls?: HubTls | null;
  /** Clock override for tests. */
  now?: () => number;
}

interface Conn { ws: WebSocket; memberId: number; kind: 'agent' | 'web'; alive: boolean }

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
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'invalid id');
  return id;
};
const body = <T extends z.ZodType>(schema: T, req: FastifyRequest): z.infer<T> => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) fail(400, r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data as z.infer<T>;
};

/** Origins allowed to call the API from a browser context: the desktop app (file://) and local dev servers. */
const allowedOrigin = (origin: string | undefined, host: string | undefined) => {
  if (!origin) return true; // not a browser, or same-origin GET
  if (origin === 'null' || origin === 'file://') return true;
  try {
    const u = new URL(origin);
    if (host && u.host === host) return true;
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:';
  } catch { return false; }
};

export function buildHub(opts: HubOptions) {
  const now = opts.now ?? Date.now;
  const db = new Db(opts.dbPath);
  const tls = opts.tls ?? null;
  const app = Fastify({
    logger: opts.logger ? { serializers: { req: r => ({ method: r.method, url: redactUrl(r.url) }) } } : false,
    bodyLimit: 2 * 1024 * 1024,
    // Shutting down must not wait for idle keep-alive connections (browsers keep them open).
    forceCloseConnections: true,
    connectionTimeout: 60_000,
    ...(tls ? { https: { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' as const } } : {}),
  });
  const conns = new Set<Conn>();
  // Sockets keep closing after the server shuts down; by then the database may be closed too.
  let closing = false;
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(heartbeat);
    for (const c of conns) c.ws.terminate();
  });

  if (!db.teamChannel()) db.createThread('channel', 'team', null, []);

  // ---- limits ----
  const limits = {
    authFailures: new RateLimiter(30, 5 * 60_000, now),     // per IP
    requests: new RateLimiter(600, 60_000, now),            // per member
    tasks: new RateLimiter(30, 60_000, now),                // per member
    messages: new RateLimiter(60, 60_000, now),             // per member
    joinRequests: new RateLimiter(5, 10 * 60_000, now),     // per IP
  };

  // ---- realtime fan-out ----

  /**
   * What `viewer` may see about `m`. Git activity, project paths and device details are the lead's status board;
   * teammates see names, roles and whether an agent is online.
   */
  const view = (m: Member, viewer: Member): Member => (viewer.isLead || viewer.id === m.id) ? m : {
    ...m, repoPath: null, git: null, presence: null, lastSeen: null, lastDisconnectedAt: null,
  };

  const send = (c: Conn, e: HubEvent) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(e)); };

  const emit = (e: HubEvent | ((viewer: Member) => HubEvent), canSee: (viewer: Member) => boolean) => {
    for (const c of conns) {
      const viewer = db.member(c.memberId);
      if (viewer && canSee(viewer)) send(c, typeof e === 'function' ? e(viewer) : e);
    }
  };
  const emitMember = (m: Member) => emit(v => ({ type: 'member.updated', member: view(m, v) }), () => true);
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

  /** Hand a queued task to the target's agent, if it is connected. The agent still has to claim it. */
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

  const tokenIdleDays = () => {
    const v = Number(db.setting('token_idle_days') ?? DEFAULT_TOKEN_IDLE_DAYS);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TOKEN_IDLE_DAYS;
  };
  const lastTouch = new Map<number, number>();

  type AuthResult = { member: Member } | { error: string };
  const authenticate = (token: string | undefined): AuthResult | null => {
    if (!token || token.length > 200) return null;
    const m = db.memberByTokenHash(hashToken(token));
    if (!m) return null;
    // A token nobody has used for a long time (a lost laptop, someone who left) stops working by itself.
    // The lead's token lives on the hub machine itself and is exempt.
    const idle = tokenIdleDays();
    if (idle > 0 && !m.isLead) {
      const active = db.tokenActiveAt(m.id);
      if (active && now() - Date.parse(active) > idle * 86_400_000) {
        return { error: `this token expired after ${idle} days without use; ask your team lead for a new one` };
      }
    }
    // Recording last use is a write; once a minute per member is plenty.
    if (now() - (lastTouch.get(m.id) ?? 0) > 60_000) { lastTouch.set(m.id, now()); db.touch(m.id, new Date(now()).toISOString()); }
    return { member: m };
  };

  // Single-use, short-lived tickets let the browser open a WebSocket without putting its token in a URL.
  const wsTickets = new Map<string, { memberId: number; expires: number }>();
  const redeemTicket = (ticket: string | undefined): Member | null => {
    if (!ticket) return null;
    const t = wsTickets.get(ticket);
    wsTickets.delete(ticket);
    if (!t || t.expires < now()) return null;
    return db.member(t.memberId);
  };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  const isPublic = (req: FastifyRequest) => {
    const path = req.url.split('?')[0]!;
    return path === '/api/health'
      || (req.method === 'POST' && path === '/api/join-requests')
      || (req.method === 'GET' && /^\/api\/join-requests\/\d+$/.test(path));
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    const originOk = allowedOrigin(origin, req.headers.host);
    if (origin && originOk) reply.header('access-control-allow-origin', origin).header('vary', 'origin');
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY');
    if (req.method === 'OPTIONS') {
      return reply.status(204)
        .header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        .header('access-control-allow-headers', 'authorization, content-type, x-claude-link-client')
        .header('access-control-max-age', '600')
        .send();
    }
    const path = req.url.split('?')[0]!;
    const isWs = path === '/ws';
    if (!path.startsWith('/api/') && !isWs) return;
    reply.header('cache-control', 'no-store');
    // A refused WebSocket upgrade must not leave its socket behind: Node no longer tracks upgrade sockets,
    // so nothing else would ever close it (and the hub could not shut down).
    const deny = (status: number, message: string) => {
      if (isWs) { reply.header('connection', 'close'); reply.raw.once('finish', () => req.raw.socket?.destroy()); }
      return reply.status(status).send({ error: message });
    };
    // A web page on some other site must not be able to drive the hub through the user's browser.
    if (!originOk) return deny(403, 'origin not allowed');
    if (isPublic(req)) return;

    const ip = clientIp(req.ip);
    if (limits.authFailures.blocked(ip)) return deny(429, 'too many failed sign-in attempts; wait a few minutes');

    const header = req.headers.authorization;
    const q = req.query as { token?: string; ticket?: string };
    let member: Member | null = null;
    let error = 'invalid or missing token';
    if (isWs && q.ticket) {
      member = redeemTicket(q.ticket);
      if (!member) error = 'invalid or expired connection ticket';
    } else {
      // Tokens in URLs end up in logs and browser history, so only the WebSocket accepts one there (older clients).
      const token = header?.startsWith('Bearer ') ? header.slice(7) : isWs ? q.token : undefined;
      const r = authenticate(token);
      if (r && 'member' in r) member = r.member;
      else if (r) error = r.error;
    }
    if (!member) {
      limits.authFailures.hit(ip);
      return deny(401, error);
    }
    if (!limits.requests.hit(`m${member.id}`)) return deny(429, 'too many requests; slow down');
    req.member = member;
  });

  const requireLead = (req: FastifyRequest) => { if (!req.member.isLead) fail(403, 'team lead only'); };
  const viaClaude = (req: FastifyRequest) => req.headers['x-claude-link-client'] === 'mcp';
  const limit = (l: RateLimiter, req: FastifyRequest, what: string) => {
    if (!l.hit(`m${req.member.id}`)) fail(429, `too many ${what}; wait a minute`);
  };

  app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.register(async scoped => {
    scoped.get('/ws', { websocket: true }, (ws, req) => {
      const kind = (req.query as { client?: string }).client === 'agent' ? 'agent' : 'web';
      const conn: Conn = { ws, memberId: req.member.id, kind, alive: true };
      conns.add(conn);
      ws.on('pong', () => { conn.alive = true; });
      if (kind === 'agent') {
        const q = req.query as { device?: string; os?: string; appVersion?: string };
        db.presence.set(conn.memberId, {
          ip: clientIp(req.ip), device: String(q.device ?? 'unknown device').slice(0, 120), os: String(q.os ?? 'unknown').slice(0, 40),
          appVersion: String(q.appVersion ?? '').slice(0, 40), connectedSince: new Date(now()).toISOString(),
        });
        db.online.add(conn.memberId);
        db.audit(conn.memberId, 'agent.connected', null, { ip: clientIp(req.ip) });
        emitMember(db.member(conn.memberId)!);
        for (const t of db.runnableTasks(conn.memberId)) dispatch(t);
      }
      send(conn, { type: 'hello', me: db.member(conn.memberId)! });
      ws.on('close', () => {
        conns.delete(conn);
        if (closing) return;
        if (kind === 'agent' && ![...conns].some(c => c.kind === 'agent' && c.memberId === conn.memberId)) {
          db.online.delete(conn.memberId);
          db.setDisconnected(conn.memberId);
          db.audit(conn.memberId, 'agent.disconnected', null);
          const m = db.member(conn.memberId);
          if (m) emitMember(m);
        }
      });
      // Clients only listen; anything they send counts as a keepalive and is otherwise ignored.
      ws.on('message', () => { conn.alive = true; });
    });
  });

  const closeConnections = (memberId: number, reason: string) => {
    for (const c of conns) if (c.memberId === memberId) c.ws.close(4001, reason);
  };

  // ---- routes ----

  app.get('/api/health', async () => ({
    ok: true, name: 'claude-link', version: HUB_VERSION,
    team: db.setting('team_name') ?? 'Claude Link team', lead: db.lead()?.name ?? null,
    tls: !!tls, fingerprint: tls?.fingerprint ?? null,
  }));

  app.post('/api/ws-ticket', async req => {
    const ticket = randomBytes(24).toString('base64url');
    for (const [k, v] of wsTickets) if (v.expires < now()) wsTickets.delete(k);
    wsTickets.set(ticket, { memberId: req.member.id, expires: now() + WS_TICKET_TTL_MS });
    return { ticket };
  });

  // ---- join requests (teammate asks, lead approves) ----

  const emitJoinRequest = (request: JoinRequest) => emit({ type: 'joinRequest.updated', request }, v => v.isLead);
  const expireJoinRequests = () => { for (const r of db.expireJoinRequests(JOIN_REQUEST_TTL_MINUTES)) emitJoinRequest(r); };

  app.post('/api/join-requests', async req => {
    const ip = clientIp(req.ip);
    if (!limits.joinRequests.hit(ip)) fail(429, 'too many join requests; wait a few minutes');
    const b = body(joinRequestBody, req);
    if (db.members().some(m => m.name.toLowerCase() === b.name.toLowerCase())) fail(409, 'someone on the team already uses that name');
    const secret = newToken();
    const request = db.createJoinRequest({
      ...b, role: b.role as Role, ip, secretHash: hashToken(secret), verifyCode: verificationCode(tls?.fingerprint ?? '', secret),
    });
    db.audit(null, 'join.requested', `join:${request.id}`, { name: b.name, ip, device: b.device });
    emitJoinRequest(request);
    // The requester computes the verification code itself, from the certificate it actually connected to.
    return { requestId: request.id, secret };
  });

  // Polled by the requester. The token is handed out exactly once, on the first poll after approval.
  app.get('/api/join-requests/:id', async req => {
    const r = db.joinRequest(idParam(req));
    const secret = (req.query as { secret?: string }).secret;
    if (!r || !secret || !safeEqualHex(hashToken(secret), r.secretHash)) fail(404, 'no such request');
    if (r!.status !== 'approved') return { status: r!.status };
    const token = newToken();
    db.setTokenHash(r!.memberId!, hashToken(token));
    db.updateJoinRequest(r!.id, 'claimed');
    db.audit(r!.memberId, 'join.claimed', `join:${r!.id}`);
    return { status: 'approved', token, member: db.member(r!.memberId!) };
  });

  app.get('/api/join-requests', async req => {
    requireLead(req);
    expireJoinRequests();
    return db.joinRequests();
  });

  app.post('/api/join-requests/:id/:decision', async req => {
    requireLead(req);
    const { decision } = req.params as { decision: string };
    if (decision !== 'approve' && decision !== 'reject') fail(404, 'not found');
    expireJoinRequests();
    const r = db.joinRequest(idParam(req)) ?? fail(404, 'no such request');
    if (r.status !== 'pending') fail(409, `request is ${r.status === 'rejected' ? 'closed (declined or expired)' : r.status}`);
    if (decision === 'reject') {
      const updated = db.updateJoinRequest(r.id, 'rejected');
      db.audit(req.member.id, 'join.rejected', `join:${r.id}`, { name: r.name });
      emitJoinRequest(updated);
      return updated;
    }
    const { access } = body(z.object({ access: z.enum(['developer', 'viewer']).default('developer') }), req);
    if (db.members().some(m => m.name.toLowerCase() === r.name.toLowerCase())) fail(409, 'a member with that name exists');
    // The real token is minted when the requester claims it; until then this hash matches nothing.
    const member = db.createMember(r.name, r.role, false, hashToken(newToken()), access);
    const updated = db.updateJoinRequest(r.id, 'approved', member.id);
    db.audit(req.member.id, 'join.approved', `join:${r.id}`, { name: r.name, member: member.id, access, verificationCode: r.verificationCode });
    emitMember(member);
    emitJoinRequest(updated);
    return updated;
  });

  // ---- team ----

  const teamSettings = () => ({
    name: db.setting('team_name') ?? 'Claude Link team',
    tokenIdleDays: tokenIdleDays(),
    tls: !!tls,
    fingerprint: tls?.fingerprint ?? null,
  });

  app.get('/api/team', async () => teamSettings());

  app.patch('/api/team', async req => {
    requireLead(req);
    const b = body(teamSettingsBody, req);
    if (b.name !== undefined) db.setSetting('team_name', b.name);
    if (b.tokenIdleDays !== undefined) db.setSetting('token_idle_days', String(b.tokenIdleDays));
    db.audit(req.member.id, 'team.updated', null, b);
    return teamSettings();
  });

  // ---- members ----

  app.get('/api/me', async req => db.member(req.member.id));

  app.get('/api/members', async req => db.members().map(m => view(m, req.member)));

  app.post('/api/members', async req => {
    requireLead(req);
    const { name, role, access } = body(createMemberBody, req);
    if (db.members().some(m => m.name.toLowerCase() === name.toLowerCase())) fail(409, 'a member with that name exists');
    const token = newToken();
    const member = db.createMember(name, role as Role, false, hashToken(token), access ?? 'developer');
    db.audit(req.member.id, 'member.created', `member:${member.id}`, { name, role, access: member.access });
    emitMember(member);
    return { member, token };
  });

  app.patch('/api/members/:id', async req => {
    requireLead(req);
    const id = idParam(req);
    const before = db.member(id) ?? fail(404, 'no such member');
    const patch = body(updateMemberBody, req);
    if (before.isLead && patch.access) fail(400, 'the team lead always has admin access');
    if (patch.name && db.members().some(m => m.id !== id && m.name.toLowerCase() === patch.name!.toLowerCase())) fail(409, 'a member with that name exists');
    const member = db.updateMember(id, patch)!;
    db.audit(req.member.id, 'member.updated', `member:${id}`, patch);
    emitMember(member);
    return member;
  });

  app.post('/api/members/:id/token', async req => {
    requireLead(req);
    const id = idParam(req);
    if (!db.member(id)) fail(404, 'no such member');
    const token = newToken();
    db.setTokenHash(id, hashToken(token), new Date(now()).toISOString());
    closeConnections(id, 'token rotated');
    db.audit(req.member.id, 'member.token_rotated', `member:${id}`);
    return { token };
  });

  app.delete('/api/members/:id', async req => {
    requireLead(req);
    const id = idParam(req);
    const m = db.member(id) ?? fail(404, 'no such member');
    if (m.isLead) fail(400, 'cannot remove the lead');
    closeConnections(id, 'removed');
    // Work waiting on (or from) someone who left would otherwise sit in the queue forever.
    for (const t of db.tasksFor(db.lead()!)) {
      if ((t.toId === id || t.fromId === id) && ['pending_approval', 'queued', 'running'].includes(t.status)) {
        emitTask(db.updateTask(t.id, { status: 'failed', result: `Cancelled: ${m.name} was removed from the team.` }));
      }
    }
    db.deleteMember(id);
    db.online.delete(id);
    db.presence.delete(id);
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
    db.setGit(req.member.id, { branch: b.branch, dirtyFiles: b.dirtyFiles, recentCommits: b.recentCommits, projects: b.projects }, b.repoPath);
    emitMember(db.member(req.member.id)!);
    return { ok: true };
  });

  // ---- chat ----

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
    limit(limits.messages, req, 'messages');
    const msg = postMessage(t.id, req.member.id, viaClaude(req) ? 'claude' : 'human', text);
    db.markRead(t.id, req.member.id);
    return msg;
  });

  app.get('/api/inbox', async req => {
    const unread = db.unreadMessages(req.member);
    const mine = db.tasksFor(req.member).filter(t => t.toId === req.member.id);
    const approvals = mine.filter(t => t.status === 'pending_approval');
    const assignments = mine.filter(t => t.mode === 'assignment' && t.status !== 'done');
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
    if (b.mode === 'fix' && from.access === 'viewer') fail(403, 'your access level (viewer) cannot request code changes');
    limit(limits.tasks, req, 'requests');
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
    db.audit(from.id, 'task.created', `task:${task.id}`, { to: to.id, mode: b.mode, via: viaClaude(req) ? 'claude' : 'human' });
    emitTask(task);
    if (status === 'queued') dispatch(task);
    return task;
  });

  const decide = (approve: boolean) => async (req: FastifyRequest) => {
    const t = visibleTask(req);
    // Only the owner of the machine the change would run on decides. Not the requester, not the lead.
    if (t.toId !== req.member.id) fail(403, 'only the owner of the target machine can decide');
    // The owner can also withdraw an approval as long as the fix has not started.
    const decidable: TaskStatus[] = approve ? ['pending_approval'] : t.mode === 'fix' ? ['pending_approval', 'queued'] : ['pending_approval'];
    if (!decidable.includes(t.status)) fail(409, `task is ${t.status}`);
    const hash = taskApprovalHash(t);
    // The agent may send the hash of what its owner actually saw; it must match the request on file.
    const sent = (req.body as { approvalHash?: unknown } | undefined)?.approvalHash;
    if (approve && sent !== undefined && sent !== hash) fail(409, 'this request changed after you looked at it; review it again');
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    const task = approve
      ? db.approveTask(t.id, req.member.id, hash)
      : db.transitionTask(t.id, decidable, 'rejected', typeof reason === 'string' ? reason.slice(0, 500) : undefined);
    if (!task) fail(409, 'task was already decided');
    db.audit(req.member.id, approve ? 'task.approved' : 'task.rejected', `task:${t.id}`, approve ? { approvalHash: hash } : null);
    if (task!.threadId) {
      postMessage(task!.threadId, null, 'system', approve
        ? `✅ ${req.member.name} approved fix #${t.id}.`
        : `⛔ ${req.member.name} rejected fix #${t.id}.`, { taskId: t.id });
    }
    emitTask(task!);
    if (approve) dispatch(task!);
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
    const assignee = db.member(t.toId);
    if (lead && assignee) {
      const dm = dmThread(req.member, lead.id === req.member.id ? assignee : lead);
      postMessage(dm.id, null, 'system', `📋 Task #${t.id} "${t.title}" → ${task.status}${b.note ? `\n\n${b.note}` : ''}`, { taskId: t.id });
    }
    db.audit(req.member.id, 'task.updated', `task:${t.id}`, { status: b.status });
    emitTask(task);
    return task;
  });

  // ---- agent callbacks ----

  const ownTask = (req: FastifyRequest) => {
    const t = db.task(idParam(req)) ?? fail(404, 'no such task');
    if (t.toId !== req.member.id) fail(403, 'not your task');
    if (t.mode === 'assignment') fail(400, 'assignments are not run by agents');
    return t;
  };

  /**
   * An agent must claim a task before running it. The claim is atomic (queued → running), so two agent
   * processes on the same account, or a re-sent dispatch, can never run the same task twice.
   * Fix tasks also have to present the hash of the request their owner approved.
   */
  app.post('/api/tasks/:id/claim', async req => {
    const t = ownTask(req);
    const { approvalHash } = body(claimTaskBody, req);
    if (t.mode === 'fix') {
      if (!t.approvalHash || !t.approvedBy) fail(409, 'this fix has not been approved');
      if (t.approvedBy !== req.member.id) fail(409, 'this fix was not approved by the owner of this machine');
      if (approvalHash !== t.approvalHash || taskApprovalHash(t) !== t.approvalHash) fail(409, 'the approval does not match this request');
    }
    const task = db.transitionTask(t.id, ['queued'], 'running', 'Started') ?? fail(409, `task is ${db.task(t.id)!.status}`);
    db.audit(req.member.id, 'task.started', `task:${t.id}`);
    emitTask(task!);
    return task;
  });

  app.post('/api/tasks/:id/progress', async req => {
    const t = ownTask(req);
    const { text } = body(taskProgressBody, req);
    // Older agents start read tasks with a progress call instead of a claim. Fixes must always be claimed.
    const from: TaskStatus[] = t.mode === 'read' ? ['queued', 'running'] : ['running'];
    const task = db.transitionTask(t.id, from, 'running', text) ?? fail(409, `task is ${t.status}`);
    emitTask(task!);
    return { ok: true };
  });

  app.post('/api/tasks/:id/complete', async req => {
    const t = ownTask(req);
    const b = body(taskCompleteBody, req);
    // Declining a question that never started is fine; a fix can only complete after it was claimed.
    const from: TaskStatus[] = t.mode === 'read' ? ['queued', 'running'] : ['running'];
    if (!from.includes(t.status)) {
      // Idempotent: an agent retrying a completion the hub already recorded gets the same answer back.
      if ((t.status === 'done' || t.status === 'failed') && t.result === b.result) return t;
      fail(409, `task is ${t.status}`);
    }
    const task = db.updateTask(t.id, { status: b.ok ? 'done' : 'failed', result: b.result, diff: b.diff ?? null, branch: b.branch ?? null });
    if (t.threadId && b.sessionId && t.mode === 'read') db.setClaudeSession(t.threadId, req.member.id, b.sessionId);
    if (t.threadId) {
      const suffix = b.branch ? `\n\n🌿 Changes committed on branch \`${b.branch}\`${b.diff ? ' (diff attached to the task)' : ''}. Nothing was merged or pushed.` : '';
      postMessage(t.threadId, req.member.id, b.ok ? 'claude' : 'system', (b.ok ? '' : `❌ Task #${t.id} failed: `) + b.result + suffix,
        { taskId: t.id, branch: b.branch ?? null, hasDiff: !!b.diff });
    }
    db.audit(req.member.id, b.ok ? 'task.done' : 'task.failed', `task:${t.id}`, { branch: b.branch ?? null });
    emitTask(task);
    return task;
  });

  app.get('/api/audit', async req => {
    requireLead(req);
    const q = req.query as { q?: string; before?: string; limit?: string };
    return db.auditLog(Math.min(Number(q.limit) || 300, 1000), { q: q.q?.slice(0, 100), before: Number(q.before) || undefined });
  });

  // ---- web app ----

  if (opts.webDir && existsSync(opts.webDir)) {
    app.register(fastifyStatic, { root: opts.webDir });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith('/api/') && String(reply.getHeader('content-type') ?? '').includes('text/html')) {
        reply.header('content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      }
      return payload;
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  /**
   * Starts listening. With TLS, one port serves both: TLS connections go to the hub, and plain HTTP gets a
   * redirect (browsers) or an "upgrade required" answer (older apps), so nobody sends a token in the clear.
   */
  const listen = async (port: number, host = '0.0.0.0'): Promise<{ port: number; close: () => Promise<void> }> => {
    if (!tls) {
      await app.listen({ port, host });
      return { port: (app.server.address() as { port: number }).port, close: () => app.close() };
    }
    await app.ready();
    const sockets = new Set<Socket>();
    const plain: HttpServer = createHttpServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/api/health' || path?.startsWith('/api/') || path === '/ws') {
        res.writeHead(426, { 'content-type': 'application/json', upgrade: 'TLS/1.2', connection: 'Upgrade' });
        res.end(JSON.stringify({ error: 'This Claude Link team uses an encrypted connection. Update Claude Link, or use https://.', https: true }));
        return;
      }
      res.writeHead(301, { location: `https://${req.headers.host ?? `localhost:${port}`}${req.url ?? '/'}` });
      res.end();
    });
    const front = createNetServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // A connection that never says anything is dropped.
      socket.setTimeout(30_000, () => socket.destroy());
      socket.once('data', first => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(first);
        // 0x16 is a TLS handshake record; anything else is plain HTTP.
        (first[0] === 0x16 ? app.server : plain).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    await new Promise<void>((resolve, reject) => { front.once('error', reject); front.listen(port, host, () => { front.off('error', reject); resolve(); }); });
    return {
      port: (front.address() as { port: number }).port,
      close: async () => {
        // Stop accepting first, then end what is open: close() only completes once every connection is gone.
        const stopped = new Promise<void>(r => front.close(() => r()));
        await app.close();
        for (const s of sockets) s.destroy();
        await stopped;
      },
    };
  };

  return { app, db, listen, fingerprint: tls?.fingerprint ?? null };
}

/** Creates the lead account on first run. Returns the token only when one was just created. */
export function ensureLead(db: Db, name: string, teamName?: string): { lead: Member; token: string | null } {
  if (teamName) db.setSetting('team_name', teamName);
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
  db.audit(lead.id, 'member.token_rotated', `member:${lead.id}`, { lead: true });
  return token;
}
