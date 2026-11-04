import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Member, Task } from '../../../shared/src/index.ts';
import type { Config } from '../config.ts';
import { home } from '../config.ts';
import { git } from './git.ts';
import { resolveClaudeBin, spawnClaude } from './claudeBin.ts';
import { PROTECTED_RULES, protectedEnv } from './protect.ts';
import { describeProjects, workspaceFor } from '../projects.ts';

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
  bin: string; cwd: string; addDirs?: string[]; prompt: string; systemPrompt: string; allowedTools: string[];
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
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d);

  return new Promise(resolve => {
    const child = spawnClaude(opts.bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: protectedEnv() });
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
  const ws = workspaceFor(config);
  if (!ws) return { ok: false, result: `${config.name} has no project folder set up for Claude Link yet.` };
  const bin = resolveClaudeBin(config.claudeBin);
  const timeoutMs = (config.taskTimeoutMinutes ?? 15) * 60_000;
  const who = `${requester.name} (${requester.role})`;
  const many = ws.projects.length > 1;
  const projectNote = many ? `${config.name} works across these projects: ${describeProjects(ws.projects)}. ` : '';

  if (task.mode === 'read') {
    return runClaude({
      bin, cwd: ws.cwd, addDirs: ws.addDirs, prompt: task.prompt, resume: resumeSessionId, timeoutMs, onProgress,
      permissionMode: 'default', allowedTools: READ_TOOLS, disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...PROTECTED_RULES],
      systemPrompt:
        `You are ${config.name}'s Claude Code, answering a request from ${who} sent through Claude Link, a team context-sharing tool. ` +
        projectNote +
        'This is READ-ONLY: never modify files. Investigate the code as needed and answer concisely with concrete file paths, ' +
        'function names and snippets. Your final message is sent back verbatim to the requester.',
    });
  }

  // Fix: every project gets an isolated worktree on the same branch name, side by side in one folder,
  // so the owner's checkouts and uncommitted work are untouched and cross-project changes are possible.
  let branch = `claude-link/task-${task.id}`;
  const taken = await Promise.all(ws.projects.map(p => git(p.path, 'rev-parse', '--verify', '--quiet', branch).then(() => true, () => false)));
  if (taken.some(Boolean)) branch += `-${Date.now()}`;
  const root = join(home(), 'worktrees', `task-${task.id}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const trees: { name: string; repo: string; wt: string }[] = [];
  const skipped: string[] = [];
  for (const p of ws.projects) {
    const wt = join(root, p.name);
    try { await git(p.path, 'worktree', 'add', '-b', branch, wt, 'HEAD'); trees.push({ name: p.name, repo: p.path, wt }); }
    catch { skipped.push(p.name); }
  }
  const cleanup = async (keepBranch: (name: string) => boolean) => {
    for (const t of trees) {
      await git(t.repo, 'worktree', 'remove', '--force', t.wt).catch(() => {});
      if (!keepBranch(t.name)) await git(t.repo, 'branch', '-D', branch).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  };
  if (!trees.length) {
    await cleanup(() => false);
    return { ok: false, result: 'Could not prepare a working copy of any project (are they git repositories with at least one commit?).' };
  }

  const changed: string[] = [];
  try {
    const run = await runClaude({
      bin, cwd: trees.length === 1 ? trees[0]!.wt : root, prompt: task.prompt, resume: null, timeoutMs, onProgress,
      permissionMode: 'acceptEdits', allowedTools: [...FIX_TOOLS, ...(config.fixAllowedTools ?? [])], disallowedTools: PROTECTED_RULES,
      systemPrompt:
        `You are ${config.name}'s Claude Code, handling a change request from ${who} sent through Claude Link. ` +
        `${config.name} approved it. ` +
        (trees.length > 1
          ? `Each folder here is an isolated git worktree of one of ${config.name}'s projects (${trees.map(t => t.name).join(', ')}), all on branch ${branch}. Change only the projects the request needs. `
          : `You are in an isolated git worktree on branch ${branch}. `) +
        'Make the smallest change that resolves the request. Do not commit, push, or switch branches; Claude Link commits for you. ' +
        'Finish with a short summary of what you changed and how to verify it.',
    });

    const diffs: string[] = [];
    for (const t of trees) {
      await git(t.wt, 'add', '-A');
      // With several projects, prefix paths with the project name so the combined diff stays readable.
      const prefix = trees.length > 1 ? [`--src-prefix=a/${t.name}/`, `--dst-prefix=b/${t.name}/`] : [];
      const diff = await git(t.wt, 'diff', '--cached', ...prefix);
      if (!diff) continue;
      changed.push(t.name);
      diffs.push(diff);
      await git(t.wt, '-c', 'user.name=Claude Link', '-c', 'user.email=claude-link@localhost',
        'commit', '-q', '-m', `claude-link: ${task.title} (task #${task.id})`, '-m', `Requested by ${who}.`);
    }
    await cleanup(name => changed.includes(name));

    let result = run.result;
    if (skipped.length) result += `\n\n(Skipped ${skipped.join(', ')}: could not create a working copy.)`;
    if (!changed.length) return { ...run, result: result + (run.ok ? '\n\n(No files were changed.)' : '') };
    if (trees.length > 1) result += `\n\nChanged project${changed.length > 1 ? 's' : ''}: ${changed.join(', ')}.`;
    const diff = diffs.join('\n');
    return { ...run, result, branch, diff: diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n… (diff truncated)' : diff };
  } catch (e) {
    await cleanup(name => changed.includes(name));
    return { ok: false, result: `Fix failed: ${(e as Error).message}`, branch: changed.length ? branch : undefined };
  }
}
