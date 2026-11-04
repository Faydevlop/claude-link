import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Project } from '../../../shared/src/index.ts';
import { home } from '../config.ts';
import type { ClaudeCapabilities } from './claudeBin.ts';
import { absoluteRulePaths, secretDenyRules } from './protect.ts';
import { selfCommand, type SpawnSpec } from './selfCommand.ts';

/**
 * What Claude Code may do, per kind of run. This is the security boundary for work requested by teammates,
 * so it is built in one place and tested on its own.
 *
 * - `read`: a teammate's question. Read/search files in the shared projects and use read-only git. Nothing else:
 *   no shell, no edits, no web, no MCP servers except Claude Link's read-only git server.
 * - `fix`: an approved change. Same, plus Edit/Write inside the isolated worktrees, plus any extra tools the owner
 *   allowed in config (e.g. running tests). The owner's real checkouts, git internals and Claude settings are denied.
 * - `personal`: the owner's own "My Claude". Read-only on files, may use the web and the Claude Link team tools.
 *
 * On Claude Code versions with `--restricted`, teammate runs also ignore the owner's user/project settings
 * (whose allow rules or hooks could widen access) and confine file tools to the working directories.
 */

export type RunMode = 'read' | 'fix' | 'personal';

/** Built-in tools that change files, run code or reach the network. */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const EXEC_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash'];
const NET_TOOLS = ['WebFetch', 'WebSearch'];

export const GIT_MCP = 'claude-link-git';
export const TEAM_MCP = 'claude-link';

export interface PolicyInput {
  mode: RunMode;
  caps: ClaudeCapabilities;
  /** Projects Claude may read (for fixes: the worktrees). Also served by the read-only git server. */
  projects: Project[];
  /** Fix: the owner's real checkouts, which Claude must not write to. */
  protectedRepos?: string[];
  /** Fix: extra allow rules from the owner's config, e.g. "Bash(npm test:*)". */
  extraAllowedTools?: string[];
  /** Personal: how to start the Claude Link team MCP server. */
  teamServer?: SpawnSpec;
  /** Directories that hold Claude Link's own data (tokens); always denied. */
  privateDirs?: string[];
}

export interface Policy {
  args: string[];
  /** Human-readable summary of the boundary, for logs and the audit trail. */
  summary: string;
  cleanup: () => void;
}

const uniq = <T>(a: T[]) => [...new Set(a)];

/**
 * Extra rules from config may only allow specific commands, e.g. "Bash(npm test:*)". Anything broader
 * (a bare tool name, "Bash(*)", file rules that would widen where Claude can write) is dropped.
 */
export function sanitizeAllowRules(rules: string[] | undefined): string[] {
  return uniq((rules ?? [])
    .filter((r): r is string => typeof r === 'string')
    .map(r => r.trim())
    .filter(r => /^Bash\((?!\s*[*:])[^()\r\n*]{2,200}(:\*)?\)$/.test(r)));
}

export function buildPolicy(input: PolicyInput): Policy {
  const { mode, caps } = input;
  const dir = join(home(), 'run', `${mode}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const projectsFile = join(dir, 'projects.json');
  writeFileSync(projectsFile, JSON.stringify(input.projects), { mode: 0o600 });

  const servers: Record<string, SpawnSpec> = { [GIT_MCP]: selfCommand(['git-mcp', projectsFile]) };
  if (mode === 'personal' && input.teamServer) servers[TEAM_MCP] = input.teamServer;
  const mcpFile = join(dir, 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });

  const extra = mode === 'fix' ? sanitizeAllowRules(input.extraAllowedTools) : [];
  const needsBash = extra.some(r => r.startsWith('Bash('));

  // Tools that exist at all for this run (when the Claude Code version can restrict them).
  const builtin = mode === 'read' ? ['Read', 'Grep', 'Glob']
    : mode === 'fix' ? ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...(needsBash ? ['Bash'] : [])]
    : ['Read', 'Grep', 'Glob', ...NET_TOOLS];

  const allowed = uniq([
    `mcp__${GIT_MCP}`,
    ...(mode === 'personal' ? [`mcp__${TEAM_MCP}`, ...NET_TOOLS] : []),
    ...extra,
  ]);

  const denied = uniq([
    ...(mode === 'fix' ? [] : WRITE_TOOLS),
    ...(mode === 'fix' ? ['NotebookEdit'] : []),
    ...(needsBash ? [] : EXEC_TOOLS),
    ...(mode === 'personal' ? [] : NET_TOOLS),
    ...(mode === 'personal' ? [] : ['Task', 'Agent']),
    ...secretDenyRules(input.privateDirs ?? []),
    ...(mode === 'fix' ? [
      // The owner's real checkouts (including their .git, so no hooks can be planted) are off limits.
      ...(input.protectedRepos ?? []).flatMap(r => absoluteRulePaths(r).map(p => `Edit(${p}/**)`)),
      // Inside the worktree: no git internals, Claude/MCP configuration or editor hooks that would run code later.
      ...['**/.git/**', '**/.claude/**', '**/.mcp.json', '**/.husky/**', '**/.vscode/tasks.json'].map(p => `Edit(${p})`),
    ] : []),
  ]);

  // Path rules are many and long (Windows cmd.exe allows 8191 characters per command line), so they go in a
  // settings file. Tool names are short and also go on the command line, so older versions still get them.
  const toolDenies = denied.filter(r => !r.includes('('));
  const settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: allowed, deny: denied } }, null, 2), { mode: 0o600 });

  const restricted = mode !== 'personal' && caps.restricted;
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', mode === 'fix' ? 'acceptEdits' : caps.dontAsk ? 'dontAsk' : 'default',
    ...(caps.permissionPrompts ? ['--permission-prompts', 'none'] : []),
    ...(restricted ? ['--restricted'] : []),
    ...(caps.tools ? ['--tools', builtin.join(',')] : []),
    ...(caps.strictMcp ? ['--strict-mcp-config'] : []),
    '--mcp-config', mcpFile,
    ...(caps.settings ? ['--settings', settingsFile] : []),
    '--allowedTools', allowed.join(','),
    '--disallowedTools', (caps.settings ? toolDenies : denied).join(','),
  ];

  const summary = [
    mode,
    restricted ? 'restricted (owner settings ignored, files confined to working dirs)' : null,
    caps.tools ? `tools: ${builtin.join(', ')}` : 'tools: deny-list (older Claude Code)',
    `allowed: ${allowed.join(', ')}`,
    caps.strictMcp ? 'MCP: only Claude Link' : null,
  ].filter(Boolean).join('; ');

  return { args, summary, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Keeps names and other teammate-supplied text from steering the system prompt. */
export const promptSafe = (s: string) => s.replace(/[\u0000-\u001f\u007f"`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
