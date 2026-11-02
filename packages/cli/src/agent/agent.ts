import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.ts';
import type { Task } from '../../../shared/src/index.ts';
import { Agent } from './core.ts';

const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function notify(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

export async function agentCommand() {
  const config = loadConfig();
  const agent = new Agent(config, { device: { name: hostname(), os: process.platform, appVersion: 'cli-0.1.0' } });

  agent.on('log', m => log(m));
  agent.on('ready', me => {
    log(`Claude Link agent for ${me.name} (${me.role}) → ${config.hubUrl}`);
    log(config.repoPath ? `Repository: ${config.repoPath}` : 'No repository configured: incoming tasks will fail. Re-run join with --repo.');
  });
  agent.on('connected', () => log('Connected to hub. Waiting for requests… (Ctrl+C to stop)'));
  agent.on('disconnected', () => log('Disconnected from hub; reconnecting…'));
  agent.on('revoked', reason => { log(`Disconnected by hub: ${reason}. Ask your team lead for a new token.`); process.exit(1); });
  agent.on('taskStarted', (task, from) => log(`▶ Task #${task.id} [${task.mode}] from ${from}: ${task.title}`));
  agent.on('taskProgress', (_task, text) => log(`  · ${text}`));
  agent.on('taskFinished', (task, res) => {
    log(`${res.ok ? '✓' : '✗'} Task #${task.id} ${res.ok ? 'done' : 'failed'}${res.branch ? ` — branch ${res.branch}` : ''}${res.ok ? '' : `: ${res.result}`}`);
    if (res.branch) log(`  Review with: git diff HEAD...${res.branch}   Merge with: git merge ${res.branch}`);
  });

  // Approvals in the terminal, one at a time.
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const pending: { task: Task; from: string }[] = [];
  let asking = false;
  const askNext = async () => {
    if (!rl || asking) return;
    const next = pending.shift();
    if (!next) return;
    asking = true;
    const { task, from } = next;
    console.log(`\n🔒 Fix request #${task.id} from ${from}'s Claude:\n${task.prompt.split('\n').map(l => '   ' + l).join('\n')}`);
    console.log('   It will run on a new branch in an isolated worktree; your checkout is not touched.');
    const answer = (await rl.question('   Approve? [y/N] ')).trim().toLowerCase();
    try {
      const t = await agent.decide(task.id, answer === 'y' || answer === 'yes');
      log(`Task #${task.id} is ${t.status}.`);
    } catch (e) { log(`Could not record decision: ${(e as Error).message}`); }
    asking = false;
    void askNext();
  };
  agent.on('approvalNeeded', (task, from) => {
    notify('Claude Link: fix request', task.title);
    if (rl) { pending.push({ task, from }); void askNext(); }
    else log(`🔒 Fix request #${task.id} needs your approval in the web app: ${config.hubUrl}`);
  });

  await agent.start();
}
