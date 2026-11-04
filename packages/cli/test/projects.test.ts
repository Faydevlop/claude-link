import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepos, uniqueNames, workspaceFor } from '../src/projects.ts';
import { runTask } from '../src/agent/runner.ts';
import type { Config } from '../src/config.ts';
import type { Task } from '../../shared/src/index.ts';
import { installFakeClaude } from './fakeClaude.ts';

let dir: string;
const savedEnv = { ...process.env };

const repo = (path: string, files: Record<string, string> = { 'app.txt': 'hello\n' }) => {
  mkdirSync(path, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: path, stdio: 'ignore' });
  g('init', '-q');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(path, f), c);
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
};

const task = (mode: 'read' | 'fix', prompt = 'do it'): Task => ({
  id: 7, fromId: 1, toId: 2, mode, status: 'queued', title: 'Fix greeting', prompt,
  result: null, diff: null, branch: null, threadId: 1, approvedBy: null, approvedAt: null, approvalHash: null, createdAt: '', updatedAt: '',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-link-projects-'));
  process.env.CLAUDE_LINK_HOME = join(dir, 'home');
});
afterEach(() => { process.env = { ...savedEnv }; });

describe('project discovery', () => {
  it('finds repositories inside a workspace folder, skipping dependencies and nested repos', () => {
    repo(join(dir, 'ws', 'frontend'));
    repo(join(dir, 'ws', 'backend'));
    repo(join(dir, 'ws', 'services', 'ai'));
    repo(join(dir, 'ws', 'frontend', 'node_modules', 'pkg'));
    mkdirSync(join(dir, 'ws', 'notes'));
    expect(findRepos(join(dir, 'ws')).map(p => p.name)).toEqual(['backend', 'frontend', 'services-ai']);
    expect(findRepos(join(dir, 'ws', 'backend'))).toHaveLength(1);
  });

  it('makes project names unique and safe', () => {
    expect(uniqueNames([{ name: 'app', path: '/a' }, { name: 'App', path: '/b' }, { name: 'my app!', path: '/c' }]).map(p => p.name))
      .toEqual(['app', 'App-2', 'my-app']);
  });

  it('starts in the workspace root and adds projects that live elsewhere', () => {
    repo(join(dir, 'ws', 'frontend'));
    repo(join(dir, 'ws', 'backend'));
    repo(join(dir, 'elsewhere', 'ai'));
    const ws = workspaceFor({
      repoPath: null, workspaceRoot: join(dir, 'ws'),
      projects: [{ name: 'frontend', path: join(dir, 'ws', 'frontend') }, { name: 'backend', path: join(dir, 'ws', 'backend') }, { name: 'ai', path: join(dir, 'elsewhere', 'ai') }],
    })!;
    expect(ws.cwd).toBe(join(dir, 'ws'));
    expect(ws.addDirs).toEqual([join(dir, 'elsewhere', 'ai')]);
    // Older single-repo configs keep working.
    expect(workspaceFor({ repoPath: join(dir, 'ws', 'backend'), workspaceRoot: null })!.cwd).toBe(join(dir, 'ws', 'backend'));
  });
});

describe('running tasks across several projects', { timeout: 30_000 }, () => {
  const config = (extra: Partial<Config> = {}): Config => {
    const bin = installFakeClaude(dir);
    repo(join(dir, 'ws', 'frontend'));
    repo(join(dir, 'ws', 'backend'));
    return {
      hubUrl: 'https://x', token: 't', memberId: 2, name: 'Ben', claudeBin: bin, workspaceRoot: join(dir, 'ws'),
      repoPath: join(dir, 'ws', 'frontend'),
      projects: [{ name: 'frontend', path: join(dir, 'ws', 'frontend') }, { name: 'backend', path: join(dir, 'ws', 'backend') }],
      ...extra,
    };
  };
  const requester = { id: 1, name: 'Ana', role: 'lead' as const };
  const run = async (mode: 'read' | 'fix', c: Config, prompt?: string) => {
    const res = await runTask(task(mode, prompt), requester, null, c, () => {});
    expect(res.ok, res.result).toBe(true);
    // Fix results have a summary appended after Claude's answer.
    return { res, out: JSON.parse(res.result.split(String.fromCharCode(10, 10))[0]!) };
  };

  it('answers questions from the workspace folder', async () => {
    const { out } = await run('read', config());
    expect(out.cwd).toContain(join('ws'));
    expect(out.entries).toEqual(['backend', 'frontend']);
  });

  it('runs questions read-only: no shell, no edits, no web, owner settings ignored', async () => {
    const { out } = await run('read', config());
    expect(out.argv).toContain('--restricted');
    expect(out.argv).toContain('--strict-mcp-config');
    expect(out.tools).toBe('Read,Grep,Glob');
    expect(out.mode).toBe('dontAsk');
    expect(out.argv).toEqual(expect.arrayContaining(['--permission-prompts', 'none']));
    // Nothing broad is allowed; the only extra is Claude Link's read-only git server.
    expect(out.allowed).toEqual(['mcp__claude-link-git']);
    expect(out.disallowed).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']));
    // Only the git server is configured, and it only knows the shared projects.
    expect(Object.keys(out.mcp.mcpServers)).toEqual(['claude-link-git']);
  });

  it('keeps secrets out of reach: env files, SSH keys, cloud credentials, Claude Link token', async () => {
    const c = config();
    const backend = join(dir, 'ws', 'backend');
    writeFileSync(join(backend, '.env'), 'DB_PASSWORD=hunter2\n');
    execFileSync('git', ['add', '.env'], { cwd: backend });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'env'], { cwd: backend });
    const { out } = await run('read', c);
    expect(out.disallowed).toEqual(expect.arrayContaining([
      'Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)', 'Bash(git show *.env*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.claude/**)',
    ]));
    // Absolute form too, and Claude Link's own data folder (which holds the token).
    expect(out.disallowed.some((r: string) => r.startsWith('Read(//') && r.endsWith('/.ssh/**)'))).toBe(true);
    expect(out.disallowed.some((r: string) => r.startsWith('Read(//') && r.includes('home/**'))).toBe(true);
    // Git history shows that the file changed, never what is in it.
    expect(out.backendLog).toContain('Binary files /dev/null and b/.env differ');
    expect(out.backendLog).not.toContain('hunter2');
  });

  it('does not hand teammates\' requests the owner\'s other credentials', async () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws';
    process.env.DATABASE_URL = 'postgres://u:pw@db/x';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-keep';
    const { out } = await run('read', config());
    expect(out.env).not.toEqual(expect.arrayContaining(['GITHUB_TOKEN']));
    for (const k of ['GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) expect(out.env).not.toContain(k);
    // Claude Code's own authentication still works.
    expect(out.env).toContain('ANTHROPIC_API_KEY');
  });

  it('falls back to an explicit deny list on Claude Code versions without --restricted/--tools', async () => {
    process.env.FAKE_CLAUDE_OLD = '1';
    const { out } = await run('read', config());
    expect(out.argv).not.toContain('--restricted');
    expect(out.tools).toBeUndefined();
    expect(out.mode).toBe('default');
    expect(out.disallowed).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'WebFetch', 'Task']));
  });

  it('gives a fix a worktree of every project and keeps the branch only where files changed', async () => {
    const c = config();
    const { res } = await run('fix', c);
    expect(res.branch).toBe('claude-link/task-7');
    expect(res.result).toContain('Changed project: backend.');
    // Combined diff is labelled by project.
    expect(res.diff).toContain('a/backend/app.txt');
    expect(res.diff).toContain('+hello fixed');

    const branches = (p: string) => execFileSync('git', ['branch', '--list'], { cwd: p, encoding: 'utf8' });
    expect(branches(join(dir, 'ws', 'backend'))).toContain('claude-link/task-7');
    expect(branches(join(dir, 'ws', 'frontend'))).not.toContain('claude-link/task-7');
    // The owner's checkouts are untouched and temporary worktrees are gone.
    expect(readFileSync(join(dir, 'ws', 'backend', 'app.txt'), 'utf8')).toBe('hello\n');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: join(dir, 'ws', 'backend'), encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    const wt = join(dir, 'home', 'worktrees');
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });

  it('bounds a fix: edits only in the worktrees, never the real checkout, git internals or Claude settings', async () => {
    const c = config();
    const res = await runTask(task('fix', 'KEEPSAME'), requester, null, c, () => {});
    const out = JSON.parse(res.result.split('\n\n')[0]!);
    expect(out.mode).toBe('acceptEdits');
    expect(out.tools).toBe('Read,Grep,Glob,Edit,Write');
    expect(out.argv).toContain('--restricted');
    // No broad allow rule for edits: acceptEdits only covers the working directories.
    expect(out.allowed).not.toContain('Edit');
    expect(out.allowed).not.toContain('Write');
    const backend = join(dir, 'ws', 'backend').replace(/\\/g, '/');
    expect(out.disallowed.some((r: string) => r.startsWith('Edit(//') && r.toLowerCase().includes(backend.slice(3).toLowerCase()))).toBe(true);
    expect(out.disallowed).toEqual(expect.arrayContaining(['Edit(**/.git/**)', 'Edit(**/.claude/**)', 'Bash', 'WebFetch']));
    expect(res.result).toContain('No files were changed');
  });

  it('only passes specific extra commands from config to fixes', async () => {
    const c = config({ fixAllowedTools: ['Bash(npm test:*)', 'Bash', 'Bash(*)', 'Edit', 'Read(//etc/**)'] });
    const res = await runTask(task('fix', 'KEEPSAME'), requester, null, c, () => {});
    const out = JSON.parse(res.result.split('\n\n')[0]!);
    expect(out.allowed).toEqual(['mcp__claude-link-git', 'Bash(npm test:*)']);
    expect(out.tools).toBe('Read,Grep,Glob,Edit,Write,Bash');
  });

  it('commits without running the repository\'s hooks', async () => {
    const c = config();
    const hooks = join(dir, 'ws', 'backend', '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho hook-ran > "$GIT_DIR/../hook-ran"\nexit 1\n', { mode: 0o755 });
    const { res } = await run('fix', c);
    expect(res.branch).toBe('claude-link/task-7');
    expect(existsSync(join(dir, 'ws', 'backend', 'hook-ran'))).toBe(false);
  });

  it('stops Claude when the agent is cancelled', async () => {
    const c = config();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const started = Date.now();
    const res = await runTask(task('read', 'HANG'), requester, null, c, () => {}, ac.signal);
    expect(res.ok).toBe(false);
    expect(res.result).toMatch(/Cancelled/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('never leaves policy files behind', async () => {
    await run('read', config());
    const runDir = join(dir, 'home', 'run');
    expect(existsSync(runDir) ? readdirSync(runDir) : []).toEqual([]);
    expect(homedir()).toBeTruthy();
  });
});
