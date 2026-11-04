import { beforeEach, describe, expect, it } from 'vitest';
import { buildHub, ensureLead } from '../src/server.ts';

type Hub = ReturnType<typeof buildHub>;

let hub: Hub;
let leadToken: string;

const call = async (token: string | null, method: string, url: string, payload?: unknown) => {
  const res = await hub.app.inject({
    method: method as 'GET', url, payload: payload as object,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, json: res.body ? res.json() : null };
};

const addMember = async (name: string, role = 'frontend') => {
  const r = await call(leadToken, 'POST', '/api/members', { name, role });
  expect(r.status).toBe(200);
  return r.json as { member: { id: number }; token: string };
};

beforeEach(async () => {
  hub = buildHub({ dbPath: ':memory:' });
  leadToken = ensureLead(hub.db, 'Lead').token!;
  await hub.app.ready();
});

describe('auth and roles', () => {
  it('rejects missing and bad tokens', async () => {
    expect((await call(null, 'GET', '/api/me')).status).toBe(401);
    expect((await call('cl_nope', 'GET', '/api/me')).status).toBe(401);
    expect((await call(null, 'GET', '/api/health')).status).toBe(200);
  });

  it('only the lead can manage members and see status/audit', async () => {
    const qa = await addMember('Quinn', 'qa');
    expect((await call(qa.token, 'GET', '/api/me')).json.name).toBe('Quinn');
    expect((await call(qa.token, 'POST', '/api/members', { name: 'X', role: 'qa' })).status).toBe(403);
    expect((await call(qa.token, 'GET', '/api/status')).status).toBe(403);
    expect((await call(qa.token, 'GET', '/api/audit')).status).toBe(403);
    expect((await call(leadToken, 'GET', '/api/status')).status).toBe(200);
  });

  it('rotating a token invalidates the old one', async () => {
    const fe = await addMember('Fran');
    const { json } = await call(leadToken, 'POST', `/api/members/${fe.member.id}/token`);
    expect((await call(fe.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(json.token, 'GET', '/api/me')).status).toBe(200);
  });
});

describe('chat visibility', () => {
  it('DMs are private to participants but visible to the lead', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const c = await addMember('Cy', 'ai');
    const dm = (await call(a.token, 'POST', '/api/threads/dm', { memberId: b.member.id })).json;
    await call(a.token, 'POST', `/api/threads/${dm.id}/messages`, { body: 'hi Ben' });

    expect((await call(b.token, 'GET', `/api/threads/${dm.id}/messages`)).json.messages[0].body).toBe('hi Ben');
    expect((await call(c.token, 'GET', `/api/threads/${dm.id}/messages`)).status).toBe(404);
    expect((await call(leadToken, 'GET', `/api/threads/${dm.id}/messages`)).status).toBe(200);
    expect((await call(c.token, 'GET', '/api/threads')).json.map((t: { kind: string }) => t.kind)).toEqual(['channel']);

    // Same pair reuses the same DM.
    expect((await call(b.token, 'POST', '/api/threads/dm', { memberId: a.member.id })).json.id).toBe(dm.id);
  });

  it('inbox reports unread messages and clears them', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const dm = (await call(a.token, 'POST', '/api/threads/dm', { memberId: b.member.id })).json;
    await call(a.token, 'POST', `/api/threads/${dm.id}/messages`, { body: 'ping' });
    const inbox = (await call(b.token, 'GET', '/api/inbox')).json;
    expect(inbox.unread[0].messages[0].body).toBe('ping');
    expect((await call(a.token, 'GET', '/api/inbox')).json.unread).toEqual([]);
    await call(b.token, 'POST', '/api/inbox/read');
    expect((await call(b.token, 'GET', '/api/inbox')).json.unread).toEqual([]);
  });
});

describe('tasks', () => {
  it('read tasks are queued immediately and completion posts the answer', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const task = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'What does /login return?' })).json;
    expect(task.status).toBe('queued');

    expect((await call(a.token, 'POST', `/api/tasks/${task.id}/complete`, { ok: true, result: 'x' })).status).toBe(403);
    await call(b.token, 'POST', `/api/tasks/${task.id}/progress`, { text: 'reading' });
    const done = (await call(b.token, 'POST', `/api/tasks/${task.id}/complete`, { ok: true, result: 'A JWT', sessionId: 's1' })).json;
    expect(done.status).toBe('done');

    const msgs = (await call(a.token, 'GET', `/api/threads/${task.threadId}/messages`)).json.messages;
    expect(msgs.at(-1)).toMatchObject({ authorId: b.member.id, authorKind: 'claude', body: 'A JWT' });
    expect(hub.db.claudeSession(task.threadId, b.member.id)).toBe('s1');

    // Follow-ups stay in the same thread; outsiders can't hijack it.
    const c = await addMember('Cy', 'ai');
    expect((await call(c.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'x', threadId: task.threadId })).status).toBe(400);
    const follow = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'and logout?', threadId: task.threadId })).json;
    expect(follow.threadId).toBe(task.threadId);
  });

  it('fix tasks need approval from the target owner only', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const task = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'fix', prompt: 'Fix the null check' })).json;
    expect(task.status).toBe('pending_approval');

    // Agent can't start it, requester and lead can't approve it.
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/progress`, { text: 'go' })).status).toBe(409);
    expect((await call(a.token, 'POST', `/api/tasks/${task.id}/approve`)).status).toBe(403);
    expect((await call(leadToken, 'POST', `/api/tasks/${task.id}/approve`)).status).toBe(403);

    const approved = (await call(b.token, 'POST', `/api/tasks/${task.id}/approve`)).json;
    expect(approved).toMatchObject({ status: 'queued', approvedBy: b.member.id });
    expect(approved.approvalHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/approve`)).status).toBe(409);
    // An approved fix still has to be claimed, with the hash of what was approved, before it can finish.
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/complete`, { ok: true, result: 'x' })).status).toBe(409);
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/claim`, { approvalHash: 'a'.repeat(64) })).status).toBe(409);
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/claim`, { approvalHash: approved.approvalHash })).json.status).toBe('running');
    const done = (await call(b.token, 'POST', `/api/tasks/${task.id}/complete`, {
      ok: true, result: 'Fixed', diff: '+x', branch: 'claude-link/task-1',
    })).json;
    expect(done).toMatchObject({ status: 'done', branch: 'claude-link/task-1', diff: '+x' });
  });

  it('rejected fixes never run', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const task = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'fix', prompt: 'rm stuff' })).json;
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/reject`)).json.status).toBe('rejected');
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/complete`, { ok: true, result: 'x' })).status).toBe(409);
  });

  it('only the lead assigns work; assignee updates it', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    expect((await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'assignment', prompt: 'x' })).status).toBe(403);
    const t = (await call(leadToken, 'POST', '/api/tasks', { toId: a.member.id, mode: 'assignment', title: 'Login page', prompt: 'Build it' })).json;
    expect(t.status).toBe('open');
    expect((await call(b.token, 'PATCH', `/api/tasks/${t.id}`, { status: 'done' })).status).toBe(404);
    expect((await call(a.token, 'PATCH', `/api/tasks/${t.id}`, { status: 'in_progress', note: 'started' })).json.status).toBe('in_progress');
    expect((await call(a.token, 'GET', '/api/inbox')).json.assignments).toHaveLength(1);
  });
});

describe('join requests', () => {
  const request = async (name = 'Rahul', role = 'frontend') => {
    const r = await call(null, 'POST', '/api/join-requests', { name, role, device: 'RAHUL-PC', os: 'win32' });
    expect(r.status).toBe(200);
    return r.json as { requestId: number; secret: string };
  };

  it('lead approves and the requester claims a working token exactly once', async () => {
    const { requestId, secret } = await request();
    expect((await call(null, 'GET', `/api/join-requests/${requestId}?secret=${secret}`)).json).toEqual({ status: 'pending' });
    expect((await call(null, 'GET', `/api/join-requests/${requestId}?secret=wrong`)).status).toBe(404);

    const list = (await call(leadToken, 'GET', '/api/join-requests')).json;
    expect(list[0]).toMatchObject({ name: 'Rahul', device: 'RAHUL-PC', os: 'win32', status: 'pending' });
    expect(list[0].secretHash).toBeUndefined();

    expect((await call(leadToken, 'POST', `/api/join-requests/${requestId}/approve`)).json.status).toBe('approved');
    const claim = (await call(null, 'GET', `/api/join-requests/${requestId}?secret=${secret}`)).json;
    expect(claim.status).toBe('approved');
    expect((await call(claim.token, 'GET', '/api/me')).json).toMatchObject({ name: 'Rahul', role: 'frontend', isLead: false });

    // Second poll does not hand out another token.
    expect((await call(null, 'GET', `/api/join-requests/${requestId}?secret=${secret}`)).json).toEqual({ status: 'claimed' });
  });

  it('only the lead sees and decides requests; rejected requests get no token', async () => {
    const a = await addMember('Ana');
    const { requestId, secret } = await request('Mallory', 'backend');
    expect((await call(a.token, 'GET', '/api/join-requests')).status).toBe(403);
    expect((await call(a.token, 'POST', `/api/join-requests/${requestId}/approve`)).status).toBe(403);
    expect((await call(null, 'POST', `/api/join-requests/${requestId}/approve`)).status).toBe(401);
    expect((await call(leadToken, 'POST', `/api/join-requests/${requestId}/reject`)).json.status).toBe('rejected');
    expect((await call(null, 'GET', `/api/join-requests/${requestId}?secret=${secret}`)).json).toEqual({ status: 'rejected' });
    expect((await call(leadToken, 'POST', `/api/join-requests/${requestId}/approve`)).status).toBe(409);
  });

  it('validates input and rate-limits per address', async () => {
    expect((await call(null, 'POST', '/api/join-requests', { name: 'Boss', role: 'lead' })).status).toBe(400);
    expect((await call(null, 'POST', '/api/join-requests', { name: 'Lead', role: 'qa' })).status).toBe(409);
    // Invalid attempts count toward the limit too.
    for (let i = 0; i < 3; i++) await request(`User${i}`);
    expect((await call(null, 'POST', '/api/join-requests', { name: 'Late', role: 'qa' })).status).toBe(429);
  });
});

describe('desktop support', () => {
  it('answers CORS preflight and reports the team name', async () => {
    const pre = await hub.app.inject({ method: 'OPTIONS', url: '/api/me' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('authorization');
    hub.db.setSetting('team_name', 'Clinica One');
    expect((await call(null, 'GET', '/api/health')).json).toMatchObject({ team: 'Clinica One', lead: 'Lead' });
  });

  it('tracks agent presence and disconnect time', async () => {
    const a = await addMember('Ana');
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=agent&token=${a.token}&device=ANA-PC&os=win32&appVersion=0.2.0`);
    await new Promise(r => ws.once('message', r));
    const online = (await call(leadToken, 'GET', '/api/members')).json.find((m: { name: string }) => m.name === 'Ana');
    expect(online).toMatchObject({ online: true, presence: { device: 'ANA-PC', os: 'win32', appVersion: '0.2.0' } });
    // Loopback connections report the machine's LAN address.
    expect(online.presence.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    ws.close();
    await new Promise(r => setTimeout(r, 100));
    const offline = (await call(leadToken, 'GET', '/api/members')).json.find((m: { name: string }) => m.name === 'Ana');
    expect(offline.online).toBe(false);
    expect(offline.presence).toBeNull();
    expect(offline.lastDisconnectedAt).toBeTruthy();
    await hub.app.close();
  });

  it('shuts down cleanly while agents are still connected', async () => {
    const a = await addMember('Ana');
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (hub.app.server.address() as { port: number }).port;
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=agent&token=${a.token}`);
    await new Promise(r => ws.once('message', r));
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    // Same order as the desktop app: stop the server, then close the database.
    await hub.app.close();
    hub.db.sql.close();
    await new Promise(r => setTimeout(r, 100));
    process.off('uncaughtException', onError);
    expect(errors).toEqual([]);
  });
});
