import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | null = null;

/** Finds the Claude Code executable: config override, PATH, then the usual install locations. */
export function resolveClaudeBin(override?: string): string {
  if (override) return override;
  if (cached) return cached;
  const isWin = process.platform === 'win32';
  try {
    const out = execFileSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Prefer a real executable over npm's .cmd shim on Windows.
    cached = hits.find(h => h.toLowerCase().endsWith('.exe')) ?? hits[0] ?? null;
  } catch { /* not on PATH */ }
  if (!cached) {
    const candidates = isWin
      ? [join(homedir(), '.local', 'bin', 'claude.exe'), join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')]
      : [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.claude', 'local', 'claude')];
    cached = candidates.find(existsSync) ?? null;
  }
  return cached ?? 'claude';
}

// cmd.exe expands %VAR% and treats " specially even inside quotes; everything else is literal within quotes.
const cmdQuote = (a: string) => `"${a.replace(/"/g, "'").replace(/%/g, ' percent')}"`;

/** Spawns Claude Code; .cmd/.bat shims on Windows must go through the shell, so arguments are quoted for cmd. */
export function spawnClaude(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return spawn(cmdQuote(bin), args.map(cmdQuote), { ...opts, shell: true, windowsHide: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

/** Runs a short Claude Code command (e.g. `mcp add`) and returns its output; throws on failure. */
export function runClaudeSync(args: string[], bin = resolveClaudeBin()): string {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const r = spawnSync(viaShell ? cmdQuote(bin) : bin, viaShell ? args.map(cmdQuote) : args,
    { encoding: 'utf8', shell: viaShell, windowsHide: true, timeout: 30_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `claude exited with ${r.status}`).trim());
  return r.stdout.trim();
}
