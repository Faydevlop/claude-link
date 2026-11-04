import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SpawnSpec { command: string; args: string[]; env: Record<string, string> }

const binPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/claude-link.js');

let override: ((sub: string[]) => SpawnSpec) | null = null;

/** The desktop app runs its own bundled entry point (Electron in node mode) instead of the CLI script. */
export function setSelfCommand(fn: (sub: string[]) => SpawnSpec) { override = fn; }

/** How to start a Claude Link subcommand (e.g. the restricted git MCP server) as a separate process. */
export function selfCommand(sub: string[]): SpawnSpec {
  if (override) return override(sub);
  return { command: process.execPath, args: [binPath, ...sub], env: process.env.CLAUDE_LINK_HOME ? { CLAUDE_LINK_HOME: process.env.CLAUDE_LINK_HOME } : {} };
}
