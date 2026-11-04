import { createHash } from 'node:crypto';
import type { Task } from './index.ts';

/**
 * Binds an approval to the exact request that was approved. Any change to who asked, who runs it,
 * the mode, the title or the prompt produces a different hash, so an approval can never be reused
 * for a request its owner did not see. Node-only (the web UI never computes it).
 */
export function taskApprovalHash(t: Pick<Task, 'id' | 'fromId' | 'toId' | 'mode' | 'title' | 'prompt'>): string {
  const canonical = JSON.stringify(['claude-link-approval-v1', t.id, t.fromId, t.toId, t.mode, t.title, t.prompt]);
  return createHash('sha256').update(canonical).digest('hex');
}
