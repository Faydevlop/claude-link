import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Member, Task } from '../../../shared/src/index.ts';
import type { Config } from '../config.ts';
import { home } from '../config.ts';
import { git } from './git.ts';
import { resolveClaudeBin, spawnClaude } from './claudeBin.ts';

export interface RunResult {
  ok: boolean;
  result: string;
  sessionId?: string;
  diff?: string;
  branch?: string;
}

type Requester = Pick<Member, 'id' | 'name' | 'role'>;

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(ls:*)'];
const FIX_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'MultiEdit'];
const MAX_DIFF = 350_000;

function describeToolUse(name: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
  return `${name} ${String(target)}`.trim().slice(0, 200);
}

/** Runs headless Claude Code and streams progress lines. */
function runClaude(opts: {
  bin: string; cwd: string; prompt: string; systemPrompt: string; allowedTools: string[];
  disallowedTools: string[]; permissionMode: string; resume: string | null; timeoutMs: number;
  onProgress: (text: string) => void;
}): Promise<RunResult> {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', opts.permissionMode,
    '--allowedTools', opts.allowedTools.join(','),
    '--disallowedTools', opts.disallowedTools.join(','),
    '--append-system-prompt', opts.systemPrompt,
  ];
  if (opts.disallowedTools.length === 0) args.splice(args.indexOf('--disallowedTools'), 2);
  if (opts.resume) args.push('--resume', opts.resume);

  return new Promise(resolve => {
    const child = spawnClaude(opts.bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let buf = '';
    let stderr = '';
    let sessionId: string | undefined;
    let final: RunResult | null = null;
    let lastProgress = 0;

    const timer = setTimeout(() => {
      final = { ok: false, result: `Timed out after ${Math.round(opts.timeoutMs / 60000)} minutes.`, sessionId };
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    const handle = (line: string) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type !== 'tool_use') continue;
          const now = Date.now();
          if (now - lastProgress < 2000) continue;
          lastProgress = now;
          opts.onProgress(describeToolUse(c.name, c.input ?? {}));
        }
      }
      if (ev.type === 'result' && !final) {
        final = { ok: !ev.is_error && ev.subtype === 'success', result: String(ev.result ?? ev.subtype ?? 'no result'), sessionId };
      }
    };

    child.stdout!.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr!.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, result: `Could not start Claude Code (${opts.bin}): ${e.message}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (buf) handle(buf);
      resolve(final ?? { ok: false, result: `Claude Code exited with code ${code}. ${stderr.trim()}`.trim(), sessionId });
    });
    child.stdin!.end(opts.prompt);
  });
}

export async function runTask(task: Task, requester: Requester, resumeSessionId: string | null, config: Config,
  onProgress: (text: string) => void): Promise<RunResult> {
  const repo = config.repoPath;
  if (!repo || !existsSync(repo)) {
    return { ok: false, result: `${config.name} has no repository configured for Claude Link (re-run join with --repo).` };
  }
  const bin = resolveClaudeBin(config.claudeBin);
  const timeoutMs = (config.taskTimeoutMinutes ?? 15) * 60_000;
  const who = `${requester.name} (${requester.role})`;

  if (task.mode === 'read') {
    return runClaude({
      bin, cwd: repo, prompt: task.prompt, resume: resumeSessionId, timeoutMs, onProgress,
      permissionMode: 'default', allowedTools: READ_TOOLS, disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      systemPrompt:
        `You are ${config.name}'s Claude Code, answering a request from ${who} sent through Claude Link, a team context-sharing tool. ` +
        'This is READ-ONLY: never modify files. Investigate the repository as needed and answer concisely with concrete file paths, ' +
        'function names and snippets. Your final message is sent back verbatim to the requester.',
    });
  }

  // Fix: work in an isolated worktree so the owner's checkout and uncommitted work are untouched.
  let branch = `claude-link/task-${task.id}`;
  if (await git(repo, 'rev-parse', '--verify', '--quiet', branch).then(() => true, () => false)) branch += `-${Date.now()}`;
  const wtRoot = join(home(), 'worktrees');
  mkdirSync(wtRoot, { recursive: true });
  const wt = join(wtRoot, `${basename(repo)}-task-${task.id}-${Date.now()}`);
  try {
    await git(repo, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  } catch (e) {
    return { ok: false, result: `Could not create a git worktree: ${(e as Error).message}` };
  }

  try {
    const run = await runClaude({
      bin, cwd: wt, prompt: task.prompt, resume: null, timeoutMs, onProgress,
      permissionMode: 'acceptEdits', allowedTools: [...FIX_TOOLS, ...(config.fixAllowedTools ?? [])], disallowedTools: [],
      systemPrompt:
        `You are ${config.name}'s Claude Code, handling a change request from ${who} sent through Claude Link. ` +
        `${config.name} approved it. You are in an isolated git worktree on branch ${branch}. ` +
        'Make the smallest change that resolves the request. Do not commit, push, or switch branches; Claude Link commits for you. ' +
        'Finish with a short summary of what you changed and how to verify it.',
    });

    await git(wt, 'add', '-A');
    const diff = await git(wt, 'diff', '--cached');
    if (!diff) {
      await git(repo, 'worktree', 'remove', '--force', wt).catch(() => {});
      await git(repo, 'branch', '-D', branch).catch(() => {});
      return { ...run, result: run.result + (run.ok ? '\n\n(No files were changed.)' : '') };
    }
    await git(wt, '-c', 'user.name=Claude Link', '-c', 'user.email=claude-link@localhost',
      'commit', '-q', '-m', `claude-link: ${task.title} (task #${task.id})`, '-m', `Requested by ${who}.`);
    await git(repo, 'worktree', 'remove', '--force', wt).catch(() => {});
    return {
      ...run,
      branch,
      diff: diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n… (diff truncated)' : diff,
    };
  } catch (e) {
    await git(repo, 'worktree', 'remove', '--force', wt).catch(() => {});
    return { ok: false, result: `Fix failed: ${(e as Error).message}`, branch };
  }
}
