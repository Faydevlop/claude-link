import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../../shared/src/index.ts';

export interface Config {
  hubUrl: string;
  token: string;
  memberId: number;
  name: string;
  /** First project; kept for older configs. */
  repoPath: string | null;
  /** All projects teammates' requests can use. */
  projects?: Project[];
  /** Folder that holds the projects, if they were picked from one. */
  workspaceRoot?: string | null;
  claudeBin?: string;
  taskTimeoutMinutes?: number;
  // Extra tools allowed for approved fix tasks, e.g. "Bash(npm test:*)".
  fixAllowedTools?: string[];
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

export function saveConfig(c: Config) {
  ensureHome();
  writeFileSync(configPath(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}
