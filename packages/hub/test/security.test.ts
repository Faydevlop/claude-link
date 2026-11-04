import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildHub, ensureLead, hashToken } from '../src/server.ts';
import { Db, SCHEMA_VERSION } from '../src/db.ts';
import { verificationCode } from '../src/tls.ts';
import { taskApprovalHash } from '../../shared/src/approval.ts';

type Hub = ReturnType<typeof buildHub>;

let hub: Hub;
let leadToken: string;
let clock = Date.parse('2026-11-05T10:00:00Z');

const call = async (token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await hub.app.inject({
    method: method as 'GET', url, payload: payload as object,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.statusCode, json: res.body ? res.json() : null, headers: res.headers };
};

const addMember = async (name: string, role = 'frontend', access?: 'developer' | 'viewer') => {
  const r = await call(leadToken, 'POST', '/api/members', { name, role, ...(access ? { access } : {}) });
  expect(r.status).toBe(200);
  return r.json as { member: { id: number; access: string }; token: string };
};

const fresh = async (opts: { now?: () => number; dbPath?: string } = {}) => {
  hub = buildHub({ dbPath: opts.dbPath ?? ':memory:', now: opts.now ?? (() => clock) });
  leadToken = ensureLead(hub.db, 'Lead').token!;
  await hub.app.ready();
};

beforeEach(async () => { clock = Date.parse('2026-11-05T10:00:00Z'); await fresh(); });

describe('access levels (RBAC), enforced by the hub', () => {
  it('viewers can chat and ask questions but not request code changes', async () => {
    const v = await addMember('Vera', 'qa', 'viewer');
    const d = await addMember('Dev', 'backend');
    expect(v.member.access).toBe('viewer');
    expect((await call(v.token, 'POST', '/api/tasks', { toId: d.member.id, mode: 'read', prompt: 'how?' })).status).toBe(200);
    expect((await call(v.token, 'POST', '/api/tasks', { toId: d.member.id, mode: 'fix', prompt: 'change it' })).status).toBe(403);
    // The lead can promote them.
    expect((await call(leadToken, 'PATCH', `/api/members/${v.member.id}`, { access: 'developer' })).json.access).toBe('developer');
    expect((await call(v.token, 'POST', '/api/tasks', { toId: d.member.id, mode: 'fix', prompt: 'change it' })).status).toBe(200);
  });

  it('nobody can be made a second lead, and only the lead manages access', async () => {
    const a = await addMember('Ana');
    expect((await call(leadToken, 'PATCH', `/api/members/${a.member.id}`, { role: 'lead' })).status).toBe(400);
    expect((await call(leadToken, 'POST', '/api/members', { name: 'Boss', role: 'lead' })).status).toBe(400);
    expect((await call(a.token, 'PATCH', `/api/members/${a.member.id}`, { access: 'developer' })).status).toBe(403);
    const lead = hub.db.lead()!;
    expect((await call(leadToken, 'PATCH', `/api/members/${lead.id}`, { access: 'viewer' })).status).toBe(400);
  });

  it('teammates do not see each other\'s git activity, folders or devices', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    await call(b.token, 'POST', '/api/status/git', { repoPath: '/home/ben/secret-project', branch: 'main', dirtyFiles: ['x'], recentCommits: [] });
    const seenByAna = (await call(a.token, 'GET', '/api/members')).json.find((m: { name: string }) => m.name === 'Ben');
    expect(seenByAna).toMatchObject({ name: 'Ben', repoPath: null, git: null, presence: null });
    const seenByLead = (await call(leadToken, 'GET', '/api/members')).json.find((m: { name: string }) => m.name === 'Ben');
    expect(seenByLead.repoPath).toBe('/home/ben/secret-project');
    // Everyone sees their own details.
    expect((await call(b.token, 'GET', '/api/members')).json.find((m: { name: string }) => m.name === 'Ben').repoPath).toBe('/home/ben/secret-project');
  });
});

describe('task execution protocol', () => {
  it('a task is claimed exactly once, even if dispatched twice', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const t = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'q' })).json;
    const [first, second] = await Promise.all([
      call(b.token, 'POST', `/api/tasks/${t.id}/claim`, {}),
      call(b.token, 'POST', `/api/tasks/${t.id}/claim`, {}),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    // Only the target can claim.
    expect((await call(a.token, 'POST', `/api/tasks/${t.id}/claim`, {})).status).toBe(403);
  });

  it('completion is idempotent, so an agent can retry after a network error', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const t = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'q' })).json;
    await call(b.token, 'POST', `/api/tasks/${t.id}/claim`, {});
    const body = { ok: true, result: 'answer' };
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/complete`, body)).json.status).toBe('done');
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/complete`, body)).json.status).toBe('done');
    const msgs = (await call(a.token, 'GET', `/api/threads/${t.threadId}/messages`)).json.messages;
    expect(msgs.filter((m: { body: string }) => m.body === 'answer')).toHaveLength(1);
    // A different result for a finished task is refused.
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/complete`, { ok: true, result: 'other' })).status).toBe(409);
  });

  it('a fix cannot be claimed without the owner\'s approval of that exact request', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const t = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'fix', prompt: 'Fix it' })).json;
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/claim`, { approvalHash: taskApprovalHash(t) })).status).toBe(409);
    // The agent's hash of what the owner saw must match the request on file.
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/approve`, { approvalHash: 'b'.repeat(64) })).status).toBe(409);
    const ok = (await call(b.token, 'POST', `/api/tasks/${t.id}/approve`, { approvalHash: taskApprovalHash(t) })).json;
    expect(ok.approvalHash).toBe(taskApprovalHash(t));
    // Someone edits the stored request after approval: the claim fails.
    hub.db.sql.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run('Fix it, and print ~/.ssh/id_rsa', t.id);
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/claim`, { approvalHash: ok.approvalHash })).status).toBe(409);
    const audit = (await call(leadToken, 'GET', '/api/audit?q=task.approved')).json;
    expect(audit[0]).toMatchObject({ action: 'task.approved', actorId: b.member.id, target: `task:${t.id}` });
  });

  it('the owner can withdraw an approval before the fix starts, but not after', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const t = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'fix', prompt: 'Fix it' })).json;
    await call(b.token, 'POST', `/api/tasks/${t.id}/approve`, {});
    expect((await call(a.token, 'POST', `/api/tasks/${t.id}/reject`, {})).status).toBe(403);
    expect((await call(b.token, 'POST', `/api/tasks/${t.id}/reject`, { reason: 'changed my mind' })).json).toMatchObject({ status: 'rejected', result: 'changed my mind' });
    const t2 = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'fix', prompt: 'Fix 2' })).json;
    const ok = (await call(b.token, 'POST', `/api/tasks/${t2.id}/approve`, {})).json;
    await call(b.token, 'POST', `/api/tasks/${t2.id}/claim`, { approvalHash: ok.approvalHash });
    expect((await call(b.token, 'POST', `/api/tasks/${t2.id}/reject`, {})).status).toBe(409);
  });

  it('removing a member disconnects them and cancels their open work', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const t = (await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: 'q' })).json;
    expect((await call(leadToken, 'DELETE', `/api/members/${b.member.id}`)).status).toBe(200);
    expect((await call(b.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(a.token, 'GET', `/api/tasks/${t.id}`)).json.status).toBe('failed');
  });

  it('limits how fast one member can create requests', async () => {
    const a = await addMember('Ana');
    const b = await addMember('Ben', 'backend');
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call(a.token, 'POST', '/api/tasks', { toId: b.member.id, mode: 'read', prompt: `q${i}` })).status);
    expect(statuses.filter(s => s === 200)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('authentication', () => {
  it('tokens are accepted in the Authorization header only (not in API URLs)', async () => {
    expect((await call(null, 'GET', `/api/me?token=${leadToken}`)).status).toBe(401);
    expect((await call(leadToken, 'GET', '/api/me')).status).toBe(200);
  });

  it('blocks an address after repeated failed sign-ins', async () => {
    for (let i = 0; i < 30; i++) await call(`cl_wrong${i}`, 'GET', '/api/me');
    const blocked = await call(leadToken, 'GET', '/api/me');
    expect(blocked.status).toBe(429);
    clock += 6 * 60_000;
    expect((await call(leadToken, 'GET', '/api/me')).status).toBe(200);
  });

  it('tokens unused for longer than the team setting stop working; the lead is exempt', async () => {
    const a = await addMember('Ana');
    expect((await call(a.token, 'GET', '/api/me')).status).toBe(200);
    clock += 31 * 86_400_000;
    const expired = await call(a.token, 'GET', '/api/me');
    expect(expired.status).toBe(401);
    expect(expired.json.error).toMatch(/expired/);
    expect((await call(leadToken, 'GET', '/api/me')).status).toBe(200);
    // A new token works again, and the lead can change or disable the limit.
    const { json } = await call(leadToken, 'POST', `/api/members/${a.member.id}/token`);
    expect((await call(json.token, 'GET', '/api/me')).status).toBe(200);
    expect((await call(leadToken, 'PATCH', '/api/team', { tokenIdleDays: 0 })).json.tokenIdleDays).toBe(0);
    clock += 400 * 86_400_000;
    expect((await call(json.token, 'GET', '/api/me')).status).toBe(200);
  });

  it('answers requests from other websites\' pages with 403', async () => {
    expect((await call(leadToken, 'GET', '/api/me', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    const ok = await call(leadToken, 'GET', '/api/me', undefined, { origin: 'null' }); // the desktop app (file://)
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('null');
    expect((await call(leadToken, 'GET', '/api/me', undefined, { origin: 'http://localhost:5173' })).status).toBe(200);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('WebSocket tickets are single-use and short-lived', async () => {
    await hub.listen(0, '127.0.0.1').then(async server => {
      const { default: WebSocket } = await import('ws');
      const open = (url: string) => new Promise<number | 'open'>(resolve => {
        const ws = new WebSocket(url);
        ws.once('open', () => { ws.close(); resolve('open'); });
        ws.once('unexpected-response', (q, r) => { q.destroy(); resolve(r.statusCode ?? 0); });
        ws.once('error', () => {});
      });
      const ticket = (await call(leadToken, 'POST', '/api/ws-ticket')).json.ticket;
      const base = `ws://127.0.0.1:${server.port}/ws?client=web`;
      expect(await open(`${base}&ticket=${ticket}`)).toBe('open');
      expect(await open(`${base}&ticket=${ticket}`)).toBe(401);
      const late = (await call(leadToken, 'POST', '/api/ws-ticket')).json.ticket;
      clock += 2 * 60_000;
      expect(await open(`${base}&ticket=${late}`)).toBe(401);
      await server.close();
    });
  });
});

describe('joining', () => {
  it('shows the lead a verification code the requester computes independently', async () => {
    const r = (await call(null, 'POST', '/api/join-requests', { name: 'Rahul', role: 'frontend', device: 'PC', os: 'win32' })).json;
    const list = (await call(leadToken, 'GET', '/api/join-requests')).json;
    // Plain-HTTP hub in this test: no certificate, so the code binds only the request secret.
    expect(list[0].verificationCode).toBe(verificationCode('', r.secret));
    expect(list[0].verificationCode).toMatch(/^\d{3} \d{3}$/);
  });

  it('a stale join request cannot be approved', async () => {
    await call(null, 'POST', '/api/join-requests', { name: 'Old', role: 'qa' });
    clock += 31 * 60_000;
    hub.db.sql.exec(`UPDATE join_requests SET created_at = '2000-01-01T00:00:00.000Z'`);
    const id = hub.db.joinRequests()[0]!.id;
    expect((await call(leadToken, 'POST', `/api/join-requests/${id}/approve`, {})).status).toBe(409);
  });

  it('the lead chooses the new member\'s access level', async () => {
    const r = (await call(null, 'POST', '/api/join-requests', { name: 'Vik', role: 'qa' })).json;
    await call(leadToken, 'POST', `/api/join-requests/${r.requestId}/approve`, { access: 'viewer' });
    const claim = (await call(null, 'GET', `/api/join-requests/${r.requestId}?secret=${r.secret}`)).json;
    expect(claim.member.access).toBe('viewer');
  });
});

describe('database upgrades', () => {
  it('upgrades an existing team database in place, keeping a backup and every record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-link-db-'));
    const path = join(dir, 'hub.db');
    // A database as written by the previous release (schema 2).
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, is_lead INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT NOT NULL UNIQUE, repo_path TEXT, git_json TEXT, last_seen TEXT, created_at TEXT NOT NULL DEFAULT 'x',
        last_disconnected_at TEXT);
      CREATE TABLE threads (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, dm_key TEXT UNIQUE, created_by INTEGER,
        claude_sessions_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE thread_participants (thread_id INTEGER NOT NULL, member_id INTEGER NOT NULL, last_read_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, member_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, author_id INTEGER, author_kind TEXT NOT NULL, body TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, prompt TEXT NOT NULL, result TEXT, diff TEXT, branch TEXT, thread_id INTEGER, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE status_updates (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, state TEXT NOT NULL, summary TEXT NOT NULL, task_id INTEGER, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, target TEXT, meta_json TEXT, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE join_requests (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, device TEXT NOT NULL, os TEXT NOT NULL, ip TEXT NOT NULL,
        secret_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', member_id INTEGER, created_at TEXT NOT NULL DEFAULT 'x');
      PRAGMA user_version = 2;
    `);
    old.prepare('INSERT INTO members (name, role, is_lead, token_hash) VALUES (?, ?, ?, ?)').run('Lead', 'lead', 1, hashToken('cl_old_lead'));
    old.prepare('INSERT INTO members (name, role, is_lead, token_hash) VALUES (?, ?, ?, ?)').run('Ana', 'frontend', 0, hashToken('cl_old_ana'));
    old.prepare(`INSERT INTO tasks (from_id, to_id, mode, status, title, prompt) VALUES (2, 1, 'read', 'done', 't', 'p')`).run();
    old.close();
    const copy = join(dir, 'before.db');
    copyFileSync(path, copy);

    const db = new Db(path);
    expect((db.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(db.lead()).toMatchObject({ name: 'Lead', access: 'admin' });
    expect(db.memberByTokenHash(hashToken('cl_old_ana'))).toMatchObject({ name: 'Ana', access: 'developer' });
    expect(db.task(1)).toMatchObject({ prompt: 'p', approvedBy: null });
    expect(readdirSync(dir).some(f => f.startsWith('hub.db.backup-v2-'))).toBe(true);
    db.sql.close();
    expect(existsSync(copy)).toBe(true);
  });

  it('refuses to open a database from a newer version instead of damaging it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'claude-link-db-')), 'hub.db');
    const d = new DatabaseSync(path);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    d.close();
    expect(() => new Db(path)).toThrow(/newer Claude Link/);
  });
});
