import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApi } from '../api.ts';
import { home, saveConfig } from '../config.ts';
import type { Member } from '../../../shared/src/index.ts';

const binPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/claude-link.js');

/** Command Claude Code runs to reach us; absolute paths so it works from any project. */
const selfCommand = () => [process.execPath, binPath];

function registerMcp() {
  const env = process.env.CLAUDE_LINK_HOME ? ['-e', `CLAUDE_LINK_HOME=${home()}`] : [];
  try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'claude-link'], { stdio: 'ignore' }); } catch {}
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', ...env, 'claude-link', '--', ...selfCommand(), 'mcp'], { stdio: 'inherit' });
}

function installHooks() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const prefix = process.env.CLAUDE_LINK_HOME ? `CLAUDE_LINK_HOME=${JSON.stringify(home())} ` : '';
  const command = `${prefix}${selfCommand().map(s => JSON.stringify(s)).join(' ')} hook`;
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  // Replace any earlier Claude Link hook rather than stacking duplicates.
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (h: { hooks?: { command?: string }[] }) => !h.hooks?.some(x => x.command?.includes('claude-link') && x.command.endsWith(' hook')),
  );
  settings.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ✓ Added a PostToolUse hook to ${settingsPath} (reports your commits to the team lead)`);
}

export async function joinCommand(hubUrl: string, opts: { token: string; repo?: string; mcp: boolean; hooks?: boolean }) {
  const url = new URL(hubUrl).origin;
  const me = await makeApi({ hubUrl: url, token: opts.token })<Member>('GET', '/api/me');
  const repoPath = opts.repo ? resolve(opts.repo.replace(/^~(?=\/)/, homedir())) : null;
  if (repoPath && !existsSync(join(repoPath, '.git'))) {
    throw new Error(`${repoPath} is not a git repository. Pass --repo <path to your project checkout>.`);
  }

  saveConfig({ hubUrl: url, token: opts.token, memberId: me.id, name: me.name, repoPath });
  console.log(`\n  ✓ Joined as ${me.name} (${me.role}) — config saved to ${home()}/config.json`);

  if (opts.mcp) {
    registerMcp();
    console.log('  ✓ Registered the "claude-link" MCP server with Claude Code (user scope)');
  }
  if (opts.hooks) installHooks();

  console.log(`\n  Next: keep the agent running so teammates' Claudes can reach yours:`);
  console.log(`    claude-link agent`);
  if (!repoPath) console.log(`  (No --repo given: incoming questions and fixes need one. Re-run join with --repo <path>.)`);
  console.log(`  Web chat: ${url}  (log in with your token)\n`);
}
