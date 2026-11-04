import { DatabaseSync } from 'node:sqlite';
import type {
  Access, AuditEntry, GitState, JoinRequest, JoinRequestStatus, Presence, Member, Message, Role, StatusUpdate, Task, TaskMode, TaskStatus, Thread, ThreadKind, AuthorKind, WorkState,
} from '../../shared/src/index.ts';

const MIGRATIONS = [
  `
  CREATE TABLE members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    is_lead INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT NOT NULL UNIQUE,
    repo_path TEXT,
    git_json TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    dm_key TEXT UNIQUE,
    created_by INTEGER,
    claude_sessions_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE thread_participants (
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, member_id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    author_id INTEGER,
    author_kind TEXT NOT NULL,
    body TEXT NOT NULL,
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX messages_thread ON messages(thread_id, id);
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    diff TEXT,
    branch TEXT,
    thread_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE status_updates (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    task_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  `
  ALTER TABLE members ADD COLUMN last_disconnected_at TEXT;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE join_requests (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    device TEXT NOT NULL,
    os TEXT NOT NULL,
    ip TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    member_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // v3: access levels, approval binding, join verification codes, token age.
  `
  ALTER TABLE members ADD COLUMN access TEXT NOT NULL DEFAULT 'developer';
  UPDATE members SET access = 'admin' WHERE is_lead = 1;
  ALTER TABLE members ADD COLUMN token_created_at TEXT;
  UPDATE members SET token_created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
  ALTER TABLE tasks ADD COLUMN approved_by INTEGER;
  ALTER TABLE tasks ADD COLUMN approved_at TEXT;
  ALTER TABLE tasks ADD COLUMN approval_hash TEXT;
  ALTER TABLE join_requests ADD COLUMN verify_code TEXT;
  CREATE INDEX tasks_to_status ON tasks(to_id, status);
  CREATE INDEX status_member ON status_updates(member_id, id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, any>;

const parse = (s: string | null) => (s ? JSON.parse(s) : null);

export class Db {
  sql: DatabaseSync;
  // Presence is in-memory: a member is online while their agent socket is open.
  online = new Set<number>();
  presence = new Map<number, Presence>();

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = (this.sql.prepare('PRAGMA user_version').get() as Row).user_version as number;
    if (version > MIGRATIONS.length) {
      throw new Error(`hub.db was written by a newer Claude Link (schema ${version}; this version knows ${MIGRATIONS.length}). Update Claude Link.`);
    }
    // Upgrading an existing database: keep a copy first, so a failed upgrade never costs the team its history.
    if (version > 0 && version < MIGRATIONS.length && path !== ':memory:') {
      this.sql.prepare('VACUUM INTO ?').run(`${path}.backup-v${version}-${Date.now()}`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
        this.sql.exec('COMMIT');
      } catch (e) {
        this.sql.exec('ROLLBACK');
        throw new Error(`Database upgrade to schema ${v + 1} failed and was rolled back: ${(e as Error).message}`);
      }
    }
  }

  // ---- members ----

  private toMember(r: Row): Member {
    return {
      id: r.id, name: r.name, role: r.role, isLead: !!r.is_lead, access: (r.is_lead ? 'admin' : r.access ?? 'developer') as Access,
      online: this.online.has(r.id), lastSeen: r.last_seen, repoPath: r.repo_path,
      git: parse(r.git_json) as GitState | null,
      presence: this.online.has(r.id) ? this.presence.get(r.id) ?? null : null,
      lastDisconnectedAt: r.last_disconnected_at ?? null,
    };
  }

  setDisconnected(id: number) {
    this.presence.delete(id);
    this.sql.prepare(`UPDATE members SET last_disconnected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
  }

  createMember(name: string, role: Role, isLead: boolean, tokenHash: string, access: Access = isLead ? 'admin' : 'developer'): Member {
    const r = this.sql.prepare(`INSERT INTO members (name, role, is_lead, token_hash, access, token_created_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
      .get(name, role, isLead ? 1 : 0, tokenHash, isLead ? 'admin' : access) as Row;
    return this.toMember(r);
  }

  memberByTokenHash(hash: string): Member | null {
    const r = this.sql.prepare('SELECT * FROM members WHERE token_hash = ?').get(hash) as Row | undefined;
    return r ? this.toMember(r) : null;
  }

  member(id: number): Member | null {
    const r = this.sql.prepare('SELECT * FROM members WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toMember(r) : null;
  }

  members(): Member[] {
    return (this.sql.prepare('SELECT * FROM members ORDER BY is_lead DESC, name').all() as Row[]).map(r => this.toMember(r));
  }

  lead(): Member | null {
    const r = this.sql.prepare('SELECT * FROM members WHERE is_lead = 1 LIMIT 1').get() as Row | undefined;
    return r ? this.toMember(r) : null;
  }

  updateMember(id: number, patch: { name?: string; role?: Role; access?: Access }): Member | null {
    if (patch.name !== undefined) this.sql.prepare('UPDATE members SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.role !== undefined) this.sql.prepare('UPDATE members SET role = ? WHERE id = ?').run(patch.role, id);
    if (patch.access !== undefined) this.sql.prepare('UPDATE members SET access = ? WHERE id = ? AND is_lead = 0').run(patch.access, id);
    return this.member(id);
  }

  /** A new token also restarts the idle clock. */
  setTokenHash(id: number, hash: string, at = new Date().toISOString()) {
    this.sql.prepare('UPDATE members SET token_hash = ?, token_created_at = ?, last_seen = NULL WHERE id = ?').run(hash, at, id);
  }

  /** The most recent of token issue time and last use: the start of the idle period. */
  tokenActiveAt(id: number): string | null {
    const r = this.sql.prepare('SELECT token_created_at AS c, last_seen AS s FROM members WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return [r.c, r.s].filter(Boolean).sort().at(-1) ?? null;
  }

  setGit(id: number, git: GitState, repoPath: string | undefined) {
    this.sql.prepare('UPDATE members SET git_json = ?, repo_path = COALESCE(?, repo_path) WHERE id = ?')
      .run(JSON.stringify(git), repoPath ?? null, id);
  }

  touch(id: number, at = new Date().toISOString()) {
    this.sql.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(at, id);
  }

  deleteMember(id: number) {
    this.sql.prepare('DELETE FROM thread_participants WHERE member_id = ?').run(id);
    this.sql.prepare('DELETE FROM members WHERE id = ?').run(id);
  }

  // ---- status ----

  private toStatus(r: Row): StatusUpdate {
    return { id: r.id, memberId: r.member_id, state: r.state, summary: r.summary, taskId: r.task_id, createdAt: r.created_at };
  }

  addStatus(memberId: number, state: WorkState, summary: string, taskId: number | null): StatusUpdate {
    return this.toStatus(this.sql.prepare('INSERT INTO status_updates (member_id, state, summary, task_id) VALUES (?, ?, ?, ?) RETURNING *')
      .get(memberId, state, summary, taskId) as Row);
  }

  latestStatuses(): StatusUpdate[] {
    return (this.sql.prepare(`
      SELECT s.* FROM status_updates s
      JOIN (SELECT member_id, MAX(id) AS id FROM status_updates GROUP BY member_id) m ON m.id = s.id
    `).all() as Row[]).map(r => this.toStatus(r));
  }

  statusHistory(memberId: number, limit = 20): StatusUpdate[] {
    return (this.sql.prepare('SELECT * FROM status_updates WHERE member_id = ? ORDER BY id DESC LIMIT ?').all(memberId, limit) as Row[])
      .map(r => this.toStatus(r));
  }

  // ---- threads & messages ----

  private toThread(r: Row, viewerId: number): Thread {
    const participantIds = (this.sql.prepare('SELECT member_id FROM thread_participants WHERE thread_id = ?').all(r.id) as Row[])
      .map(p => p.member_id as number);
    const lastRead = (this.sql.prepare('SELECT last_read_message_id AS l FROM thread_participants WHERE thread_id = ? AND member_id = ?')
      .get(r.id, viewerId) as Row | undefined)?.l ?? 0;
    const agg = this.sql.prepare(`
      SELECT MAX(created_at) AS last_at,
             SUM(CASE WHEN id > ? AND (author_id IS NULL OR author_id != ? OR author_kind != 'human') THEN 1 ELSE 0 END) AS unread
      FROM messages WHERE thread_id = ?`).get(lastRead, viewerId, r.id) as Row;
    return {
      id: r.id, kind: r.kind as ThreadKind, title: r.title, participantIds, createdBy: r.created_by,
      createdAt: r.created_at, lastMessageAt: agg.last_at ?? null, unread: agg.unread ?? 0,
    };
  }

  createThread(kind: ThreadKind, title: string, createdBy: number | null, participantIds: number[], dmKey: string | null = null): Thread {
    const r = this.sql.prepare('INSERT INTO threads (kind, title, created_by, dm_key) VALUES (?, ?, ?, ?) RETURNING *')
      .get(kind, title, createdBy, dmKey) as Row;
    for (const id of participantIds) this.addParticipant(r.id, id);
    return this.toThread(r, createdBy ?? 0);
  }

  addParticipant(threadId: number, memberId: number) {
    this.sql.prepare('INSERT OR IGNORE INTO thread_participants (thread_id, member_id) VALUES (?, ?)').run(threadId, memberId);
  }

  thread(id: number, viewerId: number): Thread | null {
    const r = this.sql.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toThread(r, viewerId) : null;
  }

  threadByDmKey(key: string, viewerId: number): Thread | null {
    const r = this.sql.prepare('SELECT * FROM threads WHERE dm_key = ?').get(key) as Row | undefined;
    return r ? this.toThread(r, viewerId) : null;
  }

  teamChannel(): Thread | null {
    const r = this.sql.prepare(`SELECT * FROM threads WHERE kind = 'channel' ORDER BY id LIMIT 1`).get() as Row | undefined;
    return r ? this.toThread(r, 0) : null;
  }

  /** Threads visible to a member. The lead sees every thread. */
  threadsFor(viewer: Member): Thread[] {
    const rows = viewer.isLead
      ? this.sql.prepare('SELECT * FROM threads').all() as Row[]
      : this.sql.prepare(`
          SELECT t.* FROM threads t
          WHERE t.kind = 'channel'
             OR EXISTS (SELECT 1 FROM thread_participants p WHERE p.thread_id = t.id AND p.member_id = ?)
        `).all(viewer.id) as Row[];
    return rows.map(r => this.toThread(r, viewer.id))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  }

  canSeeThread(viewer: Member, thread: Thread): boolean {
    return viewer.isLead || thread.kind === 'channel' || thread.participantIds.includes(viewer.id);
  }

  private toMessage(r: Row): Message {
    return {
      id: r.id, threadId: r.thread_id, authorId: r.author_id, authorKind: r.author_kind as AuthorKind,
      body: r.body, meta: parse(r.meta_json), createdAt: r.created_at,
    };
  }

  addMessage(threadId: number, authorId: number | null, authorKind: AuthorKind, body: string, meta: Record<string, unknown> | null = null): Message {
    return this.toMessage(this.sql.prepare('INSERT INTO messages (thread_id, author_id, author_kind, body, meta_json) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(threadId, authorId, authorKind, body, meta ? JSON.stringify(meta) : null) as Row);
  }

  messages(threadId: number, afterId = 0, limit = 200): Message[] {
    return (this.sql.prepare('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(threadId, afterId, limit) as Row[]).map(r => this.toMessage(r));
  }

  markRead(threadId: number, memberId: number) {
    const max = (this.sql.prepare('SELECT MAX(id) AS m FROM messages WHERE thread_id = ?').get(threadId) as Row).m ?? 0;
    // Channel threads have no explicit participant rows until someone reads them.
    this.addParticipant(threadId, memberId);
    this.sql.prepare('UPDATE thread_participants SET last_read_message_id = ? WHERE thread_id = ? AND member_id = ?').run(max, threadId, memberId);
  }

  unreadMessages(viewer: Member): { thread: Thread; messages: Message[] }[] {
    const out: { thread: Thread; messages: Message[] }[] = [];
    for (const t of this.threadsFor(viewer)) {
      // The lead can see every thread but only gets an inbox for the ones they are in.
      if (viewer.isLead && t.kind !== 'channel' && !t.participantIds.includes(viewer.id)) continue;
      if (!t.unread) continue;
      const lastRead = (this.sql.prepare('SELECT last_read_message_id AS l FROM thread_participants WHERE thread_id = ? AND member_id = ?')
        .get(t.id, viewer.id) as Row | undefined)?.l ?? 0;
      const msgs = this.messages(t.id, lastRead).filter(m => !(m.authorId === viewer.id && m.authorKind === 'human'));
      if (msgs.length) out.push({ thread: t, messages: msgs });
    }
    return out;
  }

  claudeSession(threadId: number, memberId: number): string | null {
    const r = this.sql.prepare('SELECT claude_sessions_json AS j FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    return r ? (JSON.parse(r.j)[memberId] ?? null) : null;
  }

  setClaudeSession(threadId: number, memberId: number, sessionId: string) {
    const r = this.sql.prepare('SELECT claude_sessions_json AS j FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!r) return;
    const sessions = JSON.parse(r.j);
    sessions[memberId] = sessionId;
    this.sql.prepare('UPDATE threads SET claude_sessions_json = ? WHERE id = ?').run(JSON.stringify(sessions), threadId);
  }

  // ---- tasks ----

  private toTask(r: Row): Task {
    return {
      id: r.id, fromId: r.from_id, toId: r.to_id, mode: r.mode, status: r.status, title: r.title, prompt: r.prompt,
      result: r.result, diff: r.diff, branch: r.branch, threadId: r.thread_id,
      approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null, approvalHash: r.approval_hash ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  createTask(t: { fromId: number; toId: number; mode: TaskMode; status: TaskStatus; title: string; prompt: string; threadId: number | null }): Task {
    return this.toTask(this.sql.prepare(`INSERT INTO tasks (from_id, to_id, mode, status, title, prompt, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(t.fromId, t.toId, t.mode, t.status, t.title, t.prompt, t.threadId) as Row);
  }

  task(id: number): Task | null {
    const r = this.sql.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toTask(r) : null;
  }

  updateTask(id: number, patch: Partial<Pick<Task, 'status' | 'result' | 'diff' | 'branch'>>): Task {
    // Column names come from this fixed list only, never from callers.
    const cols = (['status', 'result', 'diff', 'branch'] as const).filter(k => patch[k] !== undefined).map(k => [k, patch[k]] as const);
    const set = cols.map(([k]) => `${k} = ?`).join(', ');
    this.sql.prepare(`UPDATE tasks SET ${set}${set ? ', ' : ''}updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(...cols.map(([, v]) => v as string), id);
    return this.task(id)!;
  }

  /**
   * Moves a task to `to` only if it is still in one of the `from` statuses (compare-and-set).
   * Returns null when it was not: e.g. a second agent process already claimed it, or it was finished.
   */
  transitionTask(id: number, from: TaskStatus[], to: TaskStatus, result?: string): Task | null {
    const placeholders = from.map(() => '?').join(', ');
    const r = this.sql.prepare(`UPDATE tasks SET status = ?, result = COALESCE(?, result), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status IN (${placeholders}) RETURNING *`).get(to, result ?? null, id, ...from) as Row | undefined;
    return r ? this.toTask(r) : null;
  }

  /** Records the owner's approval of a fix, bound to a hash of the exact request. */
  approveTask(id: number, approverId: number, approvalHash: string): Task | null {
    const r = this.sql.prepare(`UPDATE tasks SET status = 'queued', approved_by = ?, approval_hash = ?,
      approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'pending_approval' RETURNING *`).get(approverId, approvalHash, id) as Row | undefined;
    return r ? this.toTask(r) : null;
  }

  tasksFor(viewer: Member): Task[] {
    const rows = viewer.isLead
      ? this.sql.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 500').all() as Row[]
      : this.sql.prepare('SELECT * FROM tasks WHERE from_id = ? OR to_id = ? ORDER BY id DESC LIMIT 500').all(viewer.id, viewer.id) as Row[];
    return rows.map(r => this.toTask(r));
  }

  /** Tasks the agent should run (approved/queued but not yet picked up), e.g. after reconnecting. */
  runnableTasks(memberId: number): Task[] {
    return (this.sql.prepare(`SELECT * FROM tasks WHERE to_id = ? AND status = 'queued' ORDER BY id`).all(memberId) as Row[])
      .map(r => this.toTask(r));
  }

  // ---- settings ----

  setting(key: string): string | null {
    return (this.sql.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.sql.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- join requests ----

  private toJoinRequest(r: Row): JoinRequest {
    return {
      id: r.id, name: r.name, role: r.role, device: r.device, os: r.os, ip: r.ip,
      status: r.status as JoinRequestStatus, memberId: r.member_id, verificationCode: r.verify_code ?? null, createdAt: r.created_at,
    };
  }

  createJoinRequest(j: { name: string; role: Role; device: string; os: string; ip: string; secretHash: string; verifyCode: string }): JoinRequest {
    return this.toJoinRequest(this.sql.prepare(`INSERT INTO join_requests (name, role, device, os, ip, secret_hash, verify_code)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(j.name, j.role, j.device, j.os, j.ip, j.secretHash, j.verifyCode) as Row);
  }

  /** Pending requests older than `minutes` lapse, so a stale request cannot be approved by accident later. */
  expireJoinRequests(minutes: number): JoinRequest[] {
    return (this.sql.prepare(`UPDATE join_requests SET status = 'rejected'
      WHERE status = 'pending' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) RETURNING *`).all(`-${minutes} minutes`) as Row[])
      .map(r => this.toJoinRequest(r));
  }

  joinRequest(id: number): (JoinRequest & { secretHash: string }) | null {
    const r = this.sql.prepare('SELECT * FROM join_requests WHERE id = ?').get(id) as Row | undefined;
    return r ? { ...this.toJoinRequest(r), secretHash: r.secret_hash } : null;
  }

  joinRequests(): JoinRequest[] {
    return (this.sql.prepare('SELECT * FROM join_requests ORDER BY id DESC LIMIT 100').all() as Row[]).map(r => this.toJoinRequest(r));
  }

  updateJoinRequest(id: number, status: JoinRequestStatus, memberId: number | null = null): JoinRequest {
    return this.toJoinRequest(this.sql.prepare('UPDATE join_requests SET status = ?, member_id = COALESCE(?, member_id) WHERE id = ? RETURNING *')
      .get(status, memberId, id) as Row);
  }

  // ---- audit ----

  audit(actorId: number | null, action: string, target: string | null, meta: Record<string, unknown> | null = null) {
    this.sql.prepare('INSERT INTO audit_log (actor_id, action, target, meta_json) VALUES (?, ?, ?, ?)')
      .run(actorId, action, target, meta ? JSON.stringify(meta) : null);
  }

  auditLog(limit = 300, opts: { before?: number; q?: string } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.before) { where.push('id < ?'); args.push(opts.before); }
    if (opts.q) {
      const like = `%${opts.q.replace(/[%_\\]/g, '')}%`;
      where.push('(action LIKE ? OR target LIKE ? OR meta_json LIKE ?)');
      args.push(like, like, like);
    }
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.sql.prepare(sql).all(...args, limit) as Row[]).map(r => ({
      id: r.id, actorId: r.actor_id, action: r.action, target: r.target, meta: parse(r.meta_json), createdAt: r.created_at,
    }));
  }
}
