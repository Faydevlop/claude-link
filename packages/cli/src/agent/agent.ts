import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';
import { makeApi, wsUrl, type ApiError } from '../api.ts';
import { loadConfig } from '../config.ts';
import type { HubEvent, Member, Task } from '../../../shared/src/index.ts';
import { gitState } from './git.ts';
import { runTask } from './runner.ts';

const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function notify(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

export async function agentCommand() {
  const config = loadConfig();
  const api = makeApi(config, 'agent');
  let me: Member;
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30_000)) {
    try { me = await api<Member>('GET', '/api/me'); break; }
    catch (e) {
      // Wait for the hub to come up; a bad token is fatal.
      if ((e as ApiError).status !== 0) throw e;
      log(`${(e as Error).message} Retrying in ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  log(`Claude Link agent for ${me.name} (${me.role}) → ${config.hubUrl}`);
  log(config.repoPath ? `Repository: ${config.repoPath}` : 'No repository configured: incoming tasks will fail. Re-run join with --repo.');

  // ---- task queue: one Claude run at a time ----
  const seen = new Set<number>();
  const queue: Extract<HubEvent, { type: 'task.run' }>[] = [];
  let busy = false;

  const pump = async () => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    const { task, requester } = job;
    log(`▶ Task #${task.id} [${task.mode}] from ${requester.name}: ${task.title}`);
    try {
      await api('POST', `/api/tasks/${task.id}/progress`, { text: 'Started' });
      const res = await runTask(task, requester, job.resumeSessionId, config, text => {
        log(`  · ${text}`);
        api('POST', `/api/tasks/${task.id}/progress`, { text }).catch(() => {});
      });
      await api('POST', `/api/tasks/${task.id}/complete`, res);
      log(`${res.ok ? '✓' : '✗'} Task #${task.id} ${res.ok ? 'done' : 'failed'}${res.branch ? ` — branch ${res.branch}` : ''}`);
      if (res.branch) log(`  Review with: git diff HEAD...${res.branch}   Merge with: git merge ${res.branch}`);
    } catch (e) {
      log(`✗ Task #${task.id}: ${(e as Error).message}`);
      await api('POST', `/api/tasks/${task.id}/complete`, { ok: false, result: (e as Error).message }).catch(() => {});
    } finally {
      busy = false;
      void pump();
    }
  };

  // ---- approvals in the terminal ----
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const prompted = new Set<number>();
  const approvalQueue: Task[] = [];
  let asking = false;

  const askNext = async () => {
    if (!rl || asking) return;
    const task = approvalQueue.shift();
    if (!task) return;
    asking = true;
    const members = await api<Member[]>('GET', '/api/members').catch(() => [] as Member[]);
    const from = members.find(m => m.id === task.fromId)?.name ?? 'someone';
    console.log(`\n🔒 Fix request #${task.id} from ${from}'s Claude:\n${task.prompt.split('\n').map(l => '   ' + l).join('\n')}`);
    console.log('   It will run on a new branch in an isolated worktree; your checkout is not touched.');
    const answer = (await rl.question('   Approve? [y/N] ')).trim().toLowerCase();
    try {
      const current = await api<Task>('GET', `/api/tasks/${task.id}`);
      if (current.status !== 'pending_approval') log(`Task #${task.id} was already ${current.status}.`);
      else await api('POST', `/api/tasks/${task.id}/${answer === 'y' || answer === 'yes' ? 'approve' : 'reject'}`);
    } catch (e) { log(`Could not record decision: ${(e as Error).message}`); }
    asking = false;
    void askNext();
  };

  const onPendingApproval = (task: Task) => {
    if (prompted.has(task.id)) return;
    prompted.add(task.id);
    notify('Claude Link: fix request', task.title);
    if (rl) { approvalQueue.push(task); void askNext(); }
    else log(`🔒 Fix request #${task.id} needs your approval in the web app: ${config.hubUrl}`);
  };

  // ---- git heartbeat ----
  const reportGit = async () => {
    if (!config.repoPath) return;
    try { await api('POST', '/api/status/git', { repoPath: config.repoPath, ...(await gitState(config.repoPath)) }); }
    catch { /* hub unreachable; retried next tick */ }
  };
  setInterval(reportGit, 60_000).unref();

  // ---- connection with reconnect ----
  let retry = 1000;
  const connect = () => {
    const ws = new WebSocket(wsUrl(config.hubUrl, config.token, 'agent'));
    let ping: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      retry = 1000;
      log('Connected to hub. Waiting for requests… (Ctrl+C to stop)');
      ping = setInterval(() => ws.ping(), 25_000);
      void reportGit();
      api<Task[]>('GET', '/api/tasks').then(ts => {
        const mine = ts.filter(t => t.toId === me.id);
        // Catch fix requests that arrived while we were offline.
        mine.filter(t => t.status === 'pending_approval').forEach(onPendingApproval);
        // A task left "running" by a previous agent process will never finish; close it out.
        for (const t of mine.filter(t => t.status === 'running' && !seen.has(t.id))) {
          api('POST', `/api/tasks/${t.id}/complete`, { ok: false, result: 'The agent restarted while this task was running. Please send it again.' }).catch(() => {});
        }
      }).catch(() => {});
    });
    ws.on('message', raw => {
      const ev = JSON.parse(String(raw)) as HubEvent;
      if (ev.type === 'task.run' && !seen.has(ev.task.id)) {
        seen.add(ev.task.id);
        queue.push(ev);
        void pump();
      } else if (ev.type === 'task.updated' && ev.task.toId === me.id && ev.task.status === 'pending_approval') {
        onPendingApproval(ev.task);
      }
    });
    ws.on('close', (code, reason) => {
      clearInterval(ping);
      if (code === 4001) { log(`Disconnected by hub: ${reason}. Ask your team lead for a new token.`); process.exit(1); }
      log(`Disconnected from hub; retrying in ${Math.round(retry / 1000)}s`);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
    ws.on('error', () => { /* close follows */ });
  };
  connect();
}
