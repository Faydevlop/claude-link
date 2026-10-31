import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../../../shared/src/index.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout.trimEnd();
}

export async function gitState(repo: string): Promise<GitState> {
  const [branch, status, log] = await Promise.all([
    git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '(unknown)'),
    git(repo, 'status', '--porcelain').catch(() => ''),
    git(repo, 'log', '-10', '--pretty=format:%h%x1f%s%x1f%cI').catch(() => ''),
  ]);
  return {
    branch,
    dirtyFiles: status ? status.split('\n').map(l => l.slice(3)).slice(0, 500) : [],
    recentCommits: log ? log.split('\n').map(l => {
      const [hash, subject, at] = l.split('\x1f');
      return { hash: hash!, subject: subject!, at: at! };
    }) : [],
  };
}
