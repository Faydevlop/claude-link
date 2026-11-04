import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../../shared/src/index.ts';
import { taskApprovalHash } from '../../../shared/src/approval.ts';
import { ensureHome, home, writePrivateJson, type Config } from '../config.ts';
import { projectsOf } from '../projects.ts';
import { sanitizeAllowRules } from './policy.ts';

/**
 * Approvals recorded on the machine that will run the fix. A fix runs only if this machine's owner approved this
 * exact request (same hash) under the same execution settings. The hub keeps its own record for the audit trail,
 * but cannot make this machine run something its owner did not approve here.
 */

interface Record_ { hubUrl: string; hash: string; exec: string; at: string }
type Store = Record<string, Record_>;

const file = () => join(home(), 'approvals.json');
const key = (hubUrl: string, taskId: number) => `${new URL(hubUrl).host}#${taskId}`;

function load(): Store {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) as Store : {}; } catch { return {}; }
}

/** What the approval also covers: which projects a fix may touch, what extra tools it gets, how long it may run. */
export function executionFingerprint(c: Config): string {
  const projects = projectsOf(c).map(p => [p.name, p.path]);
  return createHash('sha256').update(JSON.stringify({
    projects, workspaceRoot: c.workspaceRoot ?? null, tools: sanitizeAllowRules(c.fixAllowedTools), timeout: c.taskTimeoutMinutes ?? 15,
  })).digest('hex').slice(0, 32);
}

export function recordApproval(c: Config, task: Task): string {
  const hash = taskApprovalHash(task);
  const store = load();
  store[key(c.hubUrl, task.id)] = { hubUrl: c.hubUrl, hash, exec: executionFingerprint(c), at: new Date().toISOString() };
  // Keep the file small: the newest 500 approvals are plenty.
  const entries = Object.entries(store).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 500);
  ensureHome();
  writePrivateJson(file(), Object.fromEntries(entries));
  return hash;
}

export function forgetApproval(c: Config, taskId: number) {
  const store = load();
  if (delete store[key(c.hubUrl, taskId)]) { ensureHome(); writePrivateJson(file(), store); }
}

export type ApprovalCheck =
  | { ok: true; hash: string }
  | { ok: false; reason: 'missing' | 'request-changed' | 'settings-changed' | 'hub-mismatch'; message: string };

export function checkApproval(c: Config, task: Task): ApprovalCheck {
  const hash = taskApprovalHash(task);
  const rec = load()[key(c.hubUrl, task.id)];
  if (!rec) return { ok: false, reason: 'missing', message: 'This fix was not approved on this computer.' };
  if (rec.hash !== hash) return { ok: false, reason: 'request-changed', message: 'The request changed after it was approved.' };
  if (task.approvalHash && task.approvalHash !== hash) return { ok: false, reason: 'hub-mismatch', message: 'The team server\'s approval record does not match this request.' };
  if (rec.exec !== executionFingerprint(c)) {
    return { ok: false, reason: 'settings-changed', message: 'Your projects or fix permissions changed since you approved this fix.' };
  }
  return { ok: true, hash };
}
