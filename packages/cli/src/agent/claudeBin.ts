import { execFile, execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
    const out = execFileSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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

const viaShell = (bin: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);

/**
 * cmd.exe expands %VAR% and treats " specially even inside quotes; everything else is literal within quotes.
 * Newlines would end the command, so they become spaces. Only used for .cmd/.bat shims.
 */
const cmdQuote = (a: string) => `"${a.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/%/g, ' percent')}"`;

/** Spawns Claude Code; .cmd/.bat shims on Windows must go through the shell, so arguments are quoted for cmd. */
export function spawnClaude(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (viaShell(bin)) {
    return spawn(cmdQuote(bin), args.map(cmdQuote), { ...opts, shell: true, windowsHide: true });
  }
  // Own process group on Unix, so a timeout can stop everything Claude started.
  return spawn(bin, args, { ...opts, windowsHide: true, detached: process.platform !== 'win32' });
}

/** Stops a process and everything it started; escalates to a hard kill if it does not exit. */
export function killTree(child: ChildProcess, graceMs = 5000) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const t = setTimeout(() => {
    if (child.exitCode !== null) return;
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, graceMs);
  t.unref();
  child.once('exit', () => clearTimeout(t));
}

/** Runs a short Claude Code command (e.g. `mcp add`) and returns its output; throws on failure. */
export function runClaudeSync(args: string[], bin = resolveClaudeBin()): string {
  const shell = viaShell(bin);
  const r = spawnSync(shell ? cmdQuote(bin) : bin, shell ? args.map(cmdQuote) : args,
    { encoding: 'utf8', shell, windowsHide: true, timeout: 30_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `claude exited with ${r.status}`).trim());
  return r.stdout.trim();
}

export interface ClaudeCapabilities {
  /** --restricted: no code-running tools, user/project settings ignored, file tools confined to working dirs. */
  restricted: boolean;
  /** --tools: allowlist of built-in tools. */
  tools: boolean;
  strictMcp: boolean;
  /** --permission-prompts none: anything that would prompt is denied. */
  permissionPrompts: boolean;
  dontAsk: boolean;
  /** --settings <file>: extra settings (used for the permission rules, which are too long for a command line). */
  settings: boolean;
}

const capsCache = new Map<string, ClaudeCapabilities>();

/** Which hardening flags this Claude Code version supports, read from `claude --help` (no API call). */
export function claudeCapabilities(bin: string): ClaudeCapabilities {
  const hit = capsCache.get(bin);
  if (hit) return hit;
  let help = '';
  try { help = runClaudeSync(['--help'], bin); } catch { /* old or missing: assume nothing */ }
  const has = (flag: string) => new RegExp(String.raw`(^|\s)${flag}(\s|,|=|$)`, 'm').test(help);
  const caps: ClaudeCapabilities = {
    restricted: has('--restricted'),
    tools: has('--tools'),
    strictMcp: has('--strict-mcp-config'),
    permissionPrompts: has('--permission-prompts'),
    dontAsk: /dontAsk/.test(help),
    settings: has('--settings'),
  };
  capsCache.set(bin, caps);
  return caps;
}
