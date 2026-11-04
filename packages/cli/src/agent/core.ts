import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ApiError, makeApi, wsOptions, wsUrl } from '../api.ts';
import type { Config } from '../config.ts';
import { agentEventSchema, type HubEvent, type Member, type Task } from '../../../shared/src/index.ts';
import { taskApprovalHash } from '../../../shared/src/approval.ts';
import { gitState } from './git.ts';
import { runTask, type RunResult } from './runner.ts';
import { projectsOf } from '../projects.ts';
import { checkApproval, forgetApproval, recordApproval } from './approvals.ts';

type RunJob = Extract<HubEvent, { type: 'task.run' }>;
type Requester = RunJob['requester'];

export interface AgentOptions {
  /** Identifies this machine to the lead (shown on the status board). */
  device?: { name: string; os: string; appVersion: string };
  /** Called before a read-only task runs; return false to decline. */
  beforeRun?: (task: Task, requester: Requester) => Promise<boolean>;
  /**
   * Called when an approved fix arrives without an approval recorded on this machine (e.g. it was approved in a
   * browser). Return true to approve it here and run it. Without this hook such fixes are refused.
   */
  confirmFix?: (task: Task, requester: Requester, reason: string) => Promise<boolean>;
}

export interface AgentEvents {
  log: [message: string];
  ready: [me: Member];
  connected: [];
  disconnected: [reason: string];
  revoked: [reason: string];
  approvalNeeded: [task: Task, requesterName: string];
  taskStarted: [task: Task, requesterName: string];
  taskProgress: [task: Task, text: string];
  taskFinished: [task: Task, result: RunResult];
  hubEvent: [event: HubEvent];
}

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;

/**
 * Connects to the hub, keeps presence and git state fresh, and runs tasks sent to this member.
 * Front ends (CLI, desktop app) subscribe to its events for logging and approvals.
 *
 * Everything that arrives from the hub is validated before use, and nothing runs without being claimed
 * atomically on the hub first, so a re-sent or duplicated dispatch can never run a task twice.
 */
export class Agent extends EventEmitter<AgentEvents> {
  config: Config;
  me: Member | null = null;
  connected = false;
  private api;
  private opts: AgentOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  private seen = new Set<number>();
  private prompted = new Set<number>();
  private queue: RunJob[] = [];
  private busy = false;
  private timers: NodeJS.Timeout[] = [];
  private current: AbortController | null = null;
  /** Completions the hub has not acknowledged yet; retried until it does. */
  private outbox = new Map<number, Record<string, unknown>>();
  private legacyHub = false;

  constructor(config: Config, opts: AgentOptions = {}) {
    super();
    this.config = config;
    this.opts = opts;
    this.api = makeApi(config, 'agent', { reloadToken: true });
  }

  private log(m: string) { this.emit('log', m); }

  async start() {
    for (let wait = 2000; !this.stopped; wait = Math.min(wait * 2, 30_000)) {
      try { this.me = await this.api<Member>('GET', '/api/me'); break; }
      catch (e) {
        // Wait for the hub to come up; a bad token or an untrusted certificate is fatal.
        if ((e as ApiError).status !== 0) throw e;
        this.log(`${(e as Error).message} Retrying in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    if (this.stopped || !this.me) return;
    this.emit('ready', this.me);
    this.timers.push(setInterval(() => void this.reportGit(), 60_000));
    this.timers.push(setInterval(() => void this.flushOutbox(), 10_000));
    this.connect(1000);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.current?.abort();
    this.ws?.close();
  }

  /**
   * Approve or reject a pending fix aimed at this machine. Approving records the approval here first (bound to
   * the exact request), then tells the hub.
   */
  async decide(taskId: number, approve: boolean) {
    const current = await this.api<Task>('GET', `/api/tasks/${taskId}`);
    if (current.toId !== this.me?.id) throw new Error('This request is not addressed to you.');
    if (current.status !== 'pending_approval' && !(current.status === 'queued' && !approve)) return current;
    if (!approve) {
      forgetApproval(this.config, taskId);
      return this.api<Task>('POST', `/api/tasks/${taskId}/reject`, {});
    }
    const hash = recordApproval(this.config, current);
    try {
      return await this.api<Task>('POST', `/api/tasks/${taskId}/approve`, { approvalHash: hash });
    } catch (e) {
      forgetApproval(this.config, taskId);
      throw e;
    }
  }

  private async reportGit() {
    const projects = projectsOf(this.config);
    if (!projects.length) return;
    try {
      const states = await Promise.all(projects.map(async p => ({ name: p.name, ...(await gitState(p.path)) })));
      const { name: _, ...first } = states[0]!;
      await this.api('POST', '/api/status/git', {
        repoPath: projects.length > 1 ? (this.config.workspaceRoot ?? projects[0]!.path) : projects[0]!.path,
        ...first,
        projects: projects.length > 1 ? states : undefined,
      });
    } catch { /* hub unreachable; retried next tick */ }
  }

  private async requesterName(id: number) {
    const members = await this.api<Member[]>('GET', '/api/members').catch(() => [] as Member[]);
    return members.find(m => m.id === id)?.name ?? 'someone';
  }

  private async onPendingApproval(task: Task) {
    if (this.prompted.has(task.id)) return;
    this.prompted.add(task.id);
    this.emit('approvalNeeded', task, await this.requesterName(task.fromId));
  }

  /** Sends a completion; keeps it for retry if the hub cannot be reached. */
  private async complete(taskId: number, res: Record<string, unknown>) {
    this.outbox.set(taskId, res);
    await this.flushOutbox();
  }

  private async flushOutbox() {
    for (const [id, res] of [...this.outbox]) {
      try {
        await this.api('POST', `/api/tasks/${id}/complete`, res);
        this.outbox.delete(id);
      } catch (e) {
        const status = (e as ApiError).status;
        // The hub answered and will never accept it (task gone, already finished): stop retrying.
        if (status >= 400 && status < 500 && status !== 429) { this.outbox.delete(id); this.log(`Task #${id}: hub refused the result (${(e as Error).message}).`); }
        else break; // unreachable: try again later, in order
      }
    }
  }

  /** Atomically marks the task as started on the hub. False means someone else has it, or it is not runnable. */
  private async claim(task: Task, approvalHash?: string): Promise<boolean> {
    if (!this.legacyHub) {
      try { await this.api('POST', `/api/tasks/${task.id}/claim`, approvalHash ? { approvalHash } : {}); return true; }
      catch (e) {
        const err = e as ApiError;
        if (err.status === 404 && /not found/i.test(err.message)) this.legacyHub = true; // hub predates claims
        else { this.log(`Task #${task.id} not started: ${err.message}`); return false; }
      }
    }
    try { await this.api('POST', `/api/tasks/${task.id}/progress`, { text: 'Started' }); return true; }
    catch (e) { this.log(`Task #${task.id} not started: ${(e as Error).message}`); return false; }
  }

  /** Withdraws an approval the hub holds but this machine cannot honour, so the fix does not sit in the queue. */
  private async refuseFix(task: Task, reason: string) {
    this.log(`Fix #${task.id} refused: ${reason}`);
    await this.api('POST', `/api/tasks/${task.id}/reject`, { reason: `Refused on ${this.config.name}'s computer: ${reason}` }).catch(() => {});
  }

  private async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    const { task, requester } = job;
    try {
      if (task.mode === 'read') {
        if (this.opts.beforeRun && !(await this.opts.beforeRun(task, requester))) {
          await this.complete(task.id, { ok: false, result: `${this.config.name} declined this question.` });
          return;
        }
        if (!(await this.claim(task))) return;
      } else if (task.mode === 'fix') {
        let check = checkApproval(this.config, task);
        if (!check.ok && (check.reason === 'missing' || check.reason === 'settings-changed') && !this.config.trustHubApprovals) {
          const ok = this.opts.confirmFix ? await this.opts.confirmFix(task, requester, check.message) : false;
          if (!ok) { await this.refuseFix(task, check.message); return; }
          recordApproval(this.config, task);
          check = checkApproval(this.config, task);
        }
        const hash = check.ok ? check.hash : this.config.trustHubApprovals && check.reason === 'missing' && task.approvalHash === taskApprovalHash(task) ? task.approvalHash : null;
        if (!hash) { await this.refuseFix(task, check.ok ? '' : check.message); return; }
        if (!(await this.claim(task, hash))) return;
      } else {
        return; // assignments are tracked by people, never run
      }

      this.emit('taskStarted', task, requester.name);
      this.current = new AbortController();
      const res = await runTask(task, requester, job.resumeSessionId, this.config, text => {
        this.emit('taskProgress', task, text);
        this.api('POST', `/api/tasks/${task.id}/progress`, { text }).catch(() => {});
      }, this.current.signal);
      await this.complete(task.id, { ...res });
      if (task.mode === 'fix') forgetApproval(this.config, task.id);
      this.emit('taskFinished', task, res);
    } catch (e) {
      const res = { ok: false, result: (e as Error).message };
      await this.complete(task.id, res).catch(() => {});
      this.emit('taskFinished', task, res);
    } finally {
      this.current = null;
      this.busy = false;
      void this.pump();
    }
  }

  private remember(id: number) {
    this.seen.add(id);
    if (this.seen.size > 2000) for (const old of [...this.seen].slice(0, 1000)) this.seen.delete(old);
  }

  private onMessage(raw: WebSocket.RawData) {
    let data: unknown;
    try { data = JSON.parse(String(raw)); } catch { this.log('Ignored a malformed message from the hub.'); return; }
    if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
    this.emit('hubEvent', data as HubEvent);
    const type = (data as { type: string }).type;
    if (type !== 'task.run' && type !== 'task.updated') return;
    const parsed = agentEventSchema.safeParse(data);
    if (!parsed.success) { this.log(`Ignored an invalid ${type} event from the hub.`); return; }
    const ev = parsed.data;
    const task = ev.task as Task;
    if (ev.type === 'task.run') {
      // Only tasks addressed to this member, in a runnable state, once.
      if (task.toId !== this.me!.id || task.status !== 'queued' || this.seen.has(task.id)) return;
      this.remember(task.id);
      this.queue.push({ type: 'task.run', task, requester: ev.requester, resumeSessionId: ev.resumeSessionId });
      void this.pump();
    } else if (task.toId === this.me!.id && task.status === 'pending_approval') {
      void this.onPendingApproval(task);
    }
  }

  private connect(retry: number) {
    if (this.stopped) return;
    const url = new URL(wsUrl(this.config.hubUrl, 'agent'));
    if (this.opts.device) {
      url.searchParams.set('device', this.opts.device.name);
      url.searchParams.set('os', this.opts.device.os);
      url.searchParams.set('appVersion', this.opts.device.appVersion);
    }
    const ws = new WebSocket(url, wsOptions(this.config));
    this.ws = ws;
    let ping: NodeJS.Timeout | undefined;
    let lastPong = Date.now();
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('open', () => {
      retry = 1000;
      this.connected = true;
      this.emit('connected');
      lastPong = Date.now();
      ping = setInterval(() => {
        // A connection that stopped answering (sleeping laptop, dropped Wi-Fi) is closed and reopened.
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) { ws.terminate(); return; }
        try { ws.ping(); } catch { /* closing */ }
      }, PING_MS);
      void this.reportGit();
      void this.flushOutbox();
      this.api<Task[]>('GET', '/api/tasks').then(ts => {
        const mine = ts.filter(t => t.toId === this.me!.id);
        // Catch fix requests that arrived while we were offline.
        mine.filter(t => t.status === 'pending_approval').forEach(t => void this.onPendingApproval(t));
        // A task left "running" by a previous agent process will never finish; close it out.
        for (const t of mine.filter(t => t.status === 'running' && !this.seen.has(t.id) && !this.outbox.has(t.id))) {
          void this.complete(t.id, { ok: false, result: 'The agent restarted while this task was running. Please send it again.' });
        }
      }).catch(() => {});
    });
    ws.on('message', raw => this.onMessage(raw));
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) { this.stopped = true; this.emit('revoked', 'invalid or expired token'); }
      ws.terminate();
    });
    ws.on('close', (code, reason) => {
      clearInterval(ping);
      const wasConnected = this.connected;
      this.connected = false;
      if (code === 4001) { this.stopped = true; this.current?.abort(); this.emit('revoked', String(reason)); return; }
      if (this.stopped) return;
      if (wasConnected) this.emit('disconnected', 'connection lost');
      const next = Math.min(retry * 2, 30_000);
      // A little jitter keeps a whole team from reconnecting in lockstep after the hub restarts.
      setTimeout(() => this.connect(next), retry + Math.floor(Math.random() * 500));
    });
    ws.on('error', e => { if (/certificate|CERT/i.test(e.message)) this.log(`Connection refused: the team server's certificate does not match the one this computer trusts.`); });
  }
}
