import { execFileSync } from 'node:child_process';

/**
 * Apps launched from Finder/Dock get a minimal PATH, so `claude` and `git` installed via the shell
 * would not be found. Borrow PATH from the user's login shell, and never leak Electron's node mode to children.
 */
export function fixEnvironment() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'win32') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const shellPath = /__PATH__(.*)__PATH__/.exec(out)?.[1];
    if (shellPath) {
      const merged = new Set([...shellPath.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean));
      process.env.PATH = [...merged].join(':');
    }
  } catch { /* keep the default PATH */ }
}
