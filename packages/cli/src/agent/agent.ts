import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.ts';
import type { Task } from '../../../shared/src/index.ts';
import { Agent } from './core.ts';
import { projectsOf } from '../projects.ts';
import { sanitizeAllowRules } from './policy.ts';

const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function notify(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  // AppleScript string: escape backslashes and quotes, drop newlines.
  const esc = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/["\\]/g, '\\$&').slice(0, 200);
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

export async function agentCommand() {
  const config = loadConfig();
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  // Prompts in the terminal run one at a time.
  let chain = Promise.resolve();
  const ask = (render: () => void, question: string) => new Promise<boolean>(resolve => {
    chain = chain.then(async () => {
      if (!rl) return resolve(false);
      render();
      const answer = (await rl.question(question)).trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
  });

  const describeFix = (task: Task, from: string) => {
    const projects = projectsOf(config);
    const extra = sanitizeAllowRules(config.fixAllowedTools);
    console.log(`\n🔒 Fix request #${task.id} from ${from}'s Claude: "${task.title}"`);
    console.log(task.prompt.split('\n').map(l => '   │ ' + l).join('\n'));
    console.log(`   Runs in isolated git worktrees of: ${projects.map(p => p.name).join(', ') || '(no projects)'}`);
    console.log(`   Claude may read and edit files there only. ${extra.length ? `It may also run: ${extra.join(', ')}.` : 'It cannot run commands.'}`);
    console.log('   Result: a commit on a new claude-link/task-* branch. Nothing is merged or pushed.');
  };

  const agent = new Agent(config, {
    device: { name: hostname(), os: process.platform, appVersion: 'cli-0.3.0' },
    confirmFix: (task, requester, reason) => ask(() => {
      console.log(`\n⚠ ${reason}`);
      describeFix(task, requester.name);
    }, '   Approve and run it now? [y/N] '),
  });

  agent.on('log', m => log(m));
  agent.on('ready', me => {
    log(`Claude Link agent for ${me.name} (${me.role}) → ${config.hubUrl}${config.hubUrl.startsWith('https:') ? ' (encrypted, certificate pinned)' : ' (⚠ unencrypted)'}`);
    const projects = projectsOf(config);
    log(projects.length ? `Projects: ${projects.map(p => `${p.name} (${p.path})`).join(', ')}` : 'No project configured: incoming tasks will fail. Re-run join with --repo or --workspace.');
  });
  agent.on('connected', () => log('Connected to hub. Waiting for requests… (Ctrl+C to stop)'));
  agent.on('disconnected', () => log('Disconnected from hub; reconnecting…'));
  agent.on('revoked', reason => { log(`Disconnected by hub: ${reason}. Ask your team lead for a new token.`); process.exit(1); });
  agent.on('taskStarted', (task, from) => log(`▶ Task #${task.id} [${task.mode}] from ${from}: ${task.title}`));
  agent.on('taskProgress', (_task, text) => log(`  · ${text}`));
  agent.on('taskFinished', (task, res) => {
    log(`${res.ok ? '✓' : '✗'} Task #${task.id} ${res.ok ? 'done' : 'failed'}${res.branch ? ` — branch ${res.branch}` : ''}${res.ok ? '' : `: ${res.result}`}`);
    if (res.branch) log(`  Review with: git diff HEAD...${res.branch}   Merge yourself with: git merge ${res.branch}`);
  });

  agent.on('approvalNeeded', (task, from) => {
    notify('Claude Link: fix request', task.title);
    if (!rl) { log(`🔒 Fix request #${task.id} needs your approval. Run the agent in a terminal to approve it.`); return; }
    void ask(() => describeFix(task, from), '   Approve? [y/N] ').then(async yes => {
      try {
        const t = await agent.decide(task.id, yes);
        log(`Task #${task.id} is ${t.status}.`);
      } catch (e) { log(`Could not record decision: ${(e as Error).message}`); }
    });
  });

  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
  await agent.start();
}
