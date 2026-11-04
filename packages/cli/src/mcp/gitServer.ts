import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Project } from '../../../shared/src/index.ts';

/**
 * Read-only git for Claude when it works for a teammate. Replaces `Bash(git …)` permission rules, which let a
 * model pass any option (`git diff --output=<file>` writes files, `--no-index` reads outside the repo).
 * Every argument here is checked, options are fixed, and paths must stay inside the project.
 */

const MAX_OUTPUT = 200_000;

/** Revisions: names, hashes, ranges and ancestry suffixes. Never starts with "-", so it cannot become an option. */
const REV = /^(?!-)[A-Za-z0-9._\/~^@{}:+-]{1,200}$/;
const SECRET_PATH = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519|ecdsa).*|\.git-credentials|\.npmrc|\.netrc)$/i;

export class GitArgError extends Error {}

export function checkRev(rev: string): string {
  if (!REV.test(rev)) throw new GitArgError(`invalid revision: ${rev}`);
  if (rev.includes(':')) throw new GitArgError('use the "path" argument instead of rev:path');
  return rev;
}

/** A path inside the project, relative, forward slashes; secrets refused. */
export function checkPath(root: string, p: string): string {
  if (!p || p.length > 500 || p.startsWith('-') || /[\0\r\n]/.test(p)) throw new GitArgError(`invalid path: ${p}`);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new GitArgError(`path is outside the project: ${p}`);
  const norm = rel.split(/[\\/]/).join('/') || '.';
  if (norm === '.git' || norm.startsWith('.git/') || SECRET_PATH.test(norm)) throw new GitArgError(`that file is protected: ${p}`);
  return norm;
}

/** Fixed hardening for every git call: no external diff/textconv programs, no fsmonitor hook, no pager, no colour. */
const BASE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'color.ui=never', '--no-pager'];

export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...BASE, ...args], { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().slice(0, 2000)));
        resolvePromise(stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + '\n… (output truncated)' : stdout);
      });
  });
}

/**
 * Secret files never appear in diffs, whatever the repository's own .gitattributes say. Exclude-only pathspecs
 * mean "everything except these".
 */
const SECRET_EXCLUDES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '.git-credentials', '.npmrc', '.netrc']
  .map(p => `:(exclude,glob)**/${p}`);

/** Builds the argument list for each tool. Exported for tests. */
export const gitArgs = {
  status: () => ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'],
  log: (root: string, a: { max_count?: number; path?: string; author?: string; grep?: string; since?: string; rev?: string; patch?: boolean }) => {
    const args = ['log', '--no-ext-diff', '--no-textconv', `-n${Math.min(Math.max(a.max_count ?? 20, 1), 200)}`,
      '--pretty=format:%h %ad %an%n    %s', '--date=short'];
    if (a.patch) args.push('-p');
    if (a.author) args.push(`--author=${a.author.slice(0, 100)}`);
    if (a.grep) args.push(`--grep=${a.grep.slice(0, 200)}`, '--regexp-ignore-case');
    if (a.since) { if (!/^[\w .:-]{1,40}$/.test(a.since)) throw new GitArgError('invalid "since"'); args.push(`--since=${a.since}`); }
    if (a.rev) args.push(checkRev(a.rev));
    args.push('--');
    if (a.path) args.push(checkPath(root, a.path));
    // With patches, secret files are left out (their commits still show, with the other files' changes).
    else if (a.patch) args.push('.', ...SECRET_EXCLUDES);
    return args;
  },
  diff: (root: string, a: { from?: string; to?: string; path?: string; staged?: boolean; stat?: boolean }) => {
    const args = ['diff', '--no-ext-diff', '--no-textconv'];
    if (a.stat) args.push('--stat');
    if (a.staged) args.push('--cached');
    if (a.from) args.push(checkRev(a.from));
    if (a.to) args.push(checkRev(a.to));
    args.push('--', a.path ? checkPath(root, a.path) : '.', ...SECRET_EXCLUDES);
    return args;
  },
  show: (root: string, a: { rev: string; path?: string }) => {
    const rev = checkRev(a.rev);
    // A file's contents at a revision: rev:path, with the path checked like any other.
    if (a.path) return ['show', '--no-ext-diff', '--no-textconv', `${rev}:${checkPath(root, a.path)}`];
    return ['show', '--no-ext-diff', '--no-textconv', '--stat', '-p', rev, '--', '.', ...SECRET_EXCLUDES];
  },
  blame: (root: string, a: { path: string; start?: number; end?: number }) => {
    const args = ['blame', '--date=short'];
    if (a.start && a.end) args.push(`-L${Math.max(1, a.start)},${Math.max(a.start, a.end)}`);
    args.push('--', checkPath(root, a.path));
    return args;
  },
};

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t || '(no output)' }] });

export async function gitMcpCommand(projectsFile: string) {
  const projects = (JSON.parse(readFileSync(projectsFile, 'utf8')) as Project[]).filter(p => p && typeof p.path === 'string');
  if (!projects.length) throw new Error('no projects');
  const pick = (name?: string) => {
    if (!name) {
      if (projects.length === 1) return projects[0]!;
      throw new GitArgError(`several projects; pass "project" (one of: ${projects.map(p => p.name).join(', ')})`);
    }
    return projects.find(p => p.name === name) ?? (() => { throw new GitArgError(`no project named "${name}"`); })();
  };

  const server = new McpServer({ name: 'claude-link-git', version: '0.3.0' }, {
    instructions: 'Read-only git history for the projects you can read. Use these instead of running git.',
  });
  const project = z.string().max(120).optional().describe(`Project name${projects.length > 1 ? `: ${projects.map(p => p.name).join(', ')}` : ''}`);
  const tool = <S extends z.ZodRawShape>(name: string, description: string, schema: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<string>) =>
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: true } }, (async (a: z.infer<z.ZodObject<S>>) => {
      try { return text(await fn(a)); }
      catch (e) { return { ...text(`Error: ${(e as Error).message}`), isError: true }; }
    }) as never);

  tool('git_status', 'Current branch and changed files.', { project }, async a => {
    const p = pick(a.project);
    return runGit(p.path, gitArgs.status());
  });
  tool('git_log', 'Commit history, optionally for one path, author or message search.', {
    project, path: z.string().optional(), max_count: z.number().int().optional(), author: z.string().optional(),
    grep: z.string().optional(), since: z.string().optional().describe('e.g. "2 weeks ago" or 2026-01-31'),
    rev: z.string().optional().describe('branch, tag, commit or range like main..feature'), patch: z.boolean().optional(),
  }, async a => { const p = pick(a.project); return runGit(p.path, gitArgs.log(p.path, a)); });
  tool('git_diff', 'Changes between revisions, or uncommitted changes when no revision is given.', {
    project, from: z.string().optional(), to: z.string().optional(), path: z.string().optional(),
    staged: z.boolean().optional(), stat: z.boolean().optional(),
  }, async a => { const p = pick(a.project); return runGit(p.path, gitArgs.diff(p.path, a)); });
  tool('git_show', 'A commit with its changes, or (with "path") a file as it was at that revision.', {
    project, rev: z.string(), path: z.string().optional(),
  }, async a => { const p = pick(a.project); return runGit(p.path, gitArgs.show(p.path, a)); });
  tool('git_blame', 'Who last changed each line of a file.', {
    project, path: z.string(), start: z.number().int().optional(), end: z.number().int().optional(),
  }, async a => { const p = pick(a.project); return runGit(p.path, gitArgs.blame(p.path, a)); });

  await server.connect(new StdioServerTransport());
}
