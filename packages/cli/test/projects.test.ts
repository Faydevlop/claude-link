import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findRepos, uniqueNames, workspaceFor } from '../src/projects.ts';
import { runTask } from '../src/agent/runner.ts';
import type { Config } from '../src/config.ts';
import type { Task } from '../../shared/src/index.ts';

let dir: string;

const repo = (path: string, files: Record<string, string> = { 'app.txt': 'hello\n' }) => {
  mkdirSync(path, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: path, stdio: 'ignore' });
  g('init', '-q');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(path, f), c);
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
};

// Stands in for Claude Code: echoes where it ran, and in fix mode edits backend/app.txt only.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let prompt = ''; process.stdin.on('data', d => prompt += d).on('end', () => {
  const argv = process.argv.slice(2);
  const addDirs = argv.flatMap((a, i) => a === '--add-dir' ? [argv[i + 1]] : []);
  const fix = argv.includes('acceptEdits');
  if (fix) {
    const target = fs.existsSync('backend') ? 'backend/app.txt' : 'app.txt';
    fs.writeFileSync(target, 'hello fixed\\n');
  }
  const out = o => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 's1',
    result: JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync('.').sort(), addDirs }) });
});
`;

const task = (mode: 'read' | 'fix'): Task => ({
  id: 7, fromId: 1, toId: 2, mode, status: 'queued', title: 'Fix greeting', prompt: 'do it',
  result: null, diff: null, branch: null, threadId: 1, createdAt: '', updatedAt: '',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-link-projects-'));
  process.env.CLAUDE_LINK_HOME = join(dir, 'home');
});

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

describe('running tasks across several projects', () => {
  const config = (): Config => {
    const bin = join(dir, 'fake-claude.js');
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    repo(join(dir, 'ws', 'frontend'));
    repo(join(dir, 'ws', 'backend'));
    return {
      hubUrl: 'http://x', token: 't', memberId: 2, name: 'Ben', claudeBin: bin, workspaceRoot: join(dir, 'ws'),
      repoPath: join(dir, 'ws', 'frontend'),
      projects: [{ name: 'frontend', path: join(dir, 'ws', 'frontend') }, { name: 'backend', path: join(dir, 'ws', 'backend') }],
    };
  };
  const requester = { id: 1, name: 'Ana', role: 'lead' as const };

  it('answers questions from the workspace folder', async () => {
    const res = await runTask(task('read'), requester, null, config(), () => {});
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.result).cwd).toContain(join('ws'));
    expect(JSON.parse(res.result).entries).toEqual(['backend', 'frontend']);
  });

  it('gives a fix a worktree of every project and keeps the branch only where files changed', async () => {
    const c = config();
    const res = await runTask(task('fix'), requester, null, c, () => {});
    expect(res.ok).toBe(true);
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
    expect(existsSync(join(dir, 'home', 'worktrees')) && execFileSync('ls', [join(dir, 'home', 'worktrees')], { encoding: 'utf8' }).trim()).toBeFalsy();
  });
});
