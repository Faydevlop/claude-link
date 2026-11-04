import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../../shared/src/index.ts';

export interface Config {
  hubUrl: string;
  token: string;
  memberId: number;
  name: string;
  /** PEM of the hub's TLS certificate, pinned when this machine joined (https hubs). */
  hubCert?: string | null;
  /** First project; kept for older configs. */
  repoPath: string | null;
  /** All projects teammates' requests can use. */
  projects?: Project[];
  /** Folder that holds the projects, if they were picked from one. */
  workspaceRoot?: string | null;
  claudeBin?: string;
  taskTimeoutMinutes?: number;
  /**
   * Extra tools allowed for approved fix tasks, e.g. "Bash(npm test:*)". Anything here runs code from the
   * repository (tests, scripts) on this machine, outside the Claude Code permission model.
   */
  fixAllowedTools?: string[];
  /**
   * Run fix tasks approved in the hub's web page even without a local approval on this machine.
   * Off by default: approvals are recorded by this machine's own agent (terminal prompt or desktop app).
   */
  trustHubApprovals?: boolean;
}

export const home = () => process.env.CLAUDE_LINK_HOME ?? join(homedir(), '.claude-link');
export const configPath = () => join(home(), 'config.json');

export function ensureHome() {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  return home();
}

export function loadConfig(): Config {
  if (!existsSync(configPath())) {
    throw new Error(`Not joined yet (no ${configPath()}). Run: claude-link join <hub-url> --token <token>`);
  }
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
}

/** Writes owner-only, atomically (a crash mid-write never leaves a half-written config). */
export function writePrivateJson(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* not supported (Windows ACLs apply instead) */ }
}

export function saveConfig(c: Config) {
  ensureHome();
  writePrivateJson(configPath(), c);
}
