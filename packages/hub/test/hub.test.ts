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

    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/approve`)).json.status).toBe('queued');
    expect((await call(b.token, 'POST', `/api/tasks/${task.id}/approve`)).status).toBe(409);
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
