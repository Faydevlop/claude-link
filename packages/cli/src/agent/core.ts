import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { makeApi, wsUrl, type ApiError } from '../api.ts';
import type { Config } from '../config.ts';
import type { HubEvent, Member, Task } from '../../../shared/src/index.ts';
import { gitState } from './git.ts';
import { runTask, type RunResult } from './runner.ts';
import { projectsOf } from '../projects.ts';

type RunJob = Extract<HubEvent, { type: 'task.run' }>;

export interface AgentOptions {
  /** Identifies this machine to the lead (shown on the status board). */
  device?: { name: string; os: string; appVersion: string };
  /** Called before a read-only task runs; return false to decline. Fix tasks are always gated by the hub. */
  beforeRun?: (task: Task, requester: RunJob['requester']) => Promise<boolean>;
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

/**
 * Connects to the hub, keeps presence and git state fresh, and runs tasks sent to this member.
 * Front ends (CLI, desktop app) subscribe to its events for logging and approvals.
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

  constructor(config: Config, opts: AgentOptions = {}) {
    super();
    this.config = config;
    this.opts = opts;
    this.api = makeApi(config, 'agent');
  }

  private log(m: string) { this.emit('log', m); }

  async start() {
    for (let wait = 2000; !this.stopped; wait = Math.min(wait * 2, 30_000)) {
      try { this.me = await this.api<Member>('GET', '/api/me'); break; }
      catch (e) {
        // Wait for the hub to come up; a bad token is fatal.
        if ((e as ApiError).status !== 0) throw e;
        this.log(`${(e as Error).message} Retrying in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    if (this.stopped || !this.me) return;
    this.emit('ready', this.me);
    this.timers.push(setInterval(() => void this.reportGit(), 60_000));
    this.connect(1000);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.ws?.close();
  }

  /** Approve or reject a pending fix aimed at this machine. */
  async decide(taskId: number, approve: boolean) {
    const current = await this.api<Task>('GET', `/api/tasks/${taskId}`);
    if (current.status !== 'pending_approval') return current;
    return this.api<Task>('POST', `/api/tasks/${taskId}/${approve ? 'approve' : 'reject'}`);
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

  private async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    const { task, requester } = job;
    const api = this.api;
    try {
      if (task.mode === 'read' && this.opts.beforeRun && !(await this.opts.beforeRun(task, requester))) {
        await api('POST', `/api/tasks/${task.id}/complete`, { ok: false, result: `${this.config.name} declined this question.` });
        return;
      }
      this.emit('taskStarted', task, requester.name);
      await api('POST', `/api/tasks/${task.id}/progress`, { text: 'Started' });
      const res = await runTask(task, requester, job.resumeSessionId, this.config, text => {
        this.emit('taskProgress', task, text);
        api('POST', `/api/tasks/${task.id}/progress`, { text }).catch(() => {});
      });
      await api('POST', `/api/tasks/${task.id}/complete`, res);
      this.emit('taskFinished', task, res);
    } catch (e) {
      const res = { ok: false, result: (e as Error).message };
      await api('POST', `/api/tasks/${task.id}/complete`, res).catch(() => {});
      this.emit('taskFinished', task, res);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private connect(retry: number) {
    if (this.stopped) return;
    const url = new URL(wsUrl(this.config.hubUrl, this.config.token, 'agent'));
    if (this.opts.device) {
      url.searchParams.set('device', this.opts.device.name);
      url.searchParams.set('os', this.opts.device.os);
      url.searchParams.set('appVersion', this.opts.device.appVersion);
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    let ping: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      retry = 1000;
      this.connected = true;
      this.emit('connected');
      ping = setInterval(() => ws.ping(), 25_000);
      void this.reportGit();
      this.api<Task[]>('GET', '/api/tasks').then(ts => {
        const mine = ts.filter(t => t.toId === this.me!.id);
        // Catch fix requests that arrived while we were offline.
        mine.filter(t => t.status === 'pending_approval').forEach(t => void this.onPendingApproval(t));
        // A task left "running" by a previous agent process will never finish; close it out.
        for (const t of mine.filter(t => t.status === 'running' && !this.seen.has(t.id))) {
          this.api('POST', `/api/tasks/${t.id}/complete`, { ok: false, result: 'The agent restarted while this task was running. Please send it again.' }).catch(() => {});
        }
      }).catch(() => {});
    });
    ws.on('message', raw => {
      const ev = JSON.parse(String(raw)) as HubEvent;
      this.emit('hubEvent', ev);
      if (ev.type === 'task.run' && !this.seen.has(ev.task.id)) {
        this.seen.add(ev.task.id);
        this.queue.push(ev);
        void this.pump();
      } else if (ev.type === 'task.updated' && ev.task.toId === this.me!.id && ev.task.status === 'pending_approval') {
        void this.onPendingApproval(ev.task);
      }
    });
    ws.on('close', (code, reason) => {
      clearInterval(ping);
      const wasConnected = this.connected;
      this.connected = false;
      if (code === 4001) { this.stopped = true; this.emit('revoked', String(reason)); return; }
      if (this.stopped) return;
      if (wasConnected) this.emit('disconnected', 'connection lost');
      setTimeout(() => this.connect(Math.min(retry * 2, 30_000)), retry);
    });
    ws.on('error', () => { /* close follows */ });
  }
}
