import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Environment files hold secrets: Claude may never read or write them, in any project. */
export const PROTECTED_RULES = [
  ...['Read', 'Edit'].flatMap(tool => ['**/.env', '**/.env.*', '//**/.env', '//**/.env.*'].map(p => `${tool}(${p})`)),
  // `git show HEAD:.env` prints a committed file directly.
  'Bash(git show *.env*)', 'Bash(git diff *.env*)', 'Bash(git log *.env*)',
];

let attributesFile: string | null = null;

/**
 * process.env plus a git setting that marks env files as binary, so git diff/log/show print
 * "Binary files differ" instead of their contents. Applies only to processes started with it.
 */
export function protectedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!attributesFile) {
    attributesFile = join(tmpdir(), 'claude-link-gitattributes');
    writeFileSync(attributesFile, '.env -diff\n.env.* -diff\n');
  }
  const n = Number(base.GIT_CONFIG_COUNT) || 0;
  return { ...base, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.attributesFile', [`GIT_CONFIG_VALUE_${n}`]: attributesFile };
}
