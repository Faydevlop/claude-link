import { app } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeBin, spawnClaude } from '../../../cli/src/agent/claudeBin.ts';
import type { MyClaudeMessage, MyClaudeSession } from '../../../shared/src/desktop.ts';
import { dataDir, loadSettings } from './settings.ts';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(ls:*)'];
const EDIT_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const TEAM_TOOLS = 'mcp__claude-link';

const sessionsFile = () => join(dataDir(), 'my-claude.json');
let sessions: MyClaudeSession[] | null = null;
const running = new Map<string, ChildProcess>();

function all(): MyClaudeSession[] {
  if (sessions) return sessions;
  try { sessions = existsSync(sessionsFile()) ? JSON.parse(readFileSync(sessionsFile(), 'utf8')) : []; }
  catch { sessions = []; }
  // Anything marked running belonged to a previous app run.
  for (const s of sessions!) s.running = false;
  return sessions!;
}

const persist = () => writeFileSync(sessionsFile(), JSON.stringify(all().slice(0, 100)));

/** The bundled MCP server runs with Electron in node mode; files Node can execute live outside the asar archive. */
export function mcpEntry() {
  return join(__dirname, 'mcp.js').replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`);
}

export function mcpServerSpec() {
  return { command: process.execPath, args: [mcpEntry()], env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_LINK_HOME: dataDir() } };
}

function mcpConfigFile() {
  const f = join(dataDir(), 'mcp-config.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { 'claude-link': mcpServerSpec() } }, null, 2));
  return f;
}

const describeTool = (name: string, input: Record<string, unknown>) => {
  if (name.startsWith('mcp__claude-link__')) {
    const tool = name.slice('mcp__claude-link__'.length).replace(/_/g, ' ');
    const who = input.member ?? input.to;
    return `🔗 ${tool}${who ? ` → ${String(who)}` : ''}`;
  }
  const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? '';
  return `${name} ${String(target)}`.trim().slice(0, 160);
};

export const listSessions = () => all();

export function removeSession(id: string) {
  stopSession(id);
  sessions = all().filter(s => s.id !== id);
  persist();
}

export function stopSession(id: string) {
  running.get(id)?.kill('SIGTERM');
}

export function sendMessage(input: { sessionId: string | null; text: string; mode: 'ask' | 'edit' }, emit: (s: MyClaudeSession) => void): MyClaudeSession {
  const settings = loadSettings();
  if (!settings) throw new Error('Not set up yet');
  let session = input.sessionId ? all().find(s => s.id === input.sessionId) : undefined;
  if (session?.running) throw new Error('Claude is still working on the previous message.');
  if (!session) {
    session = { id: randomUUID(), title: input.text.slice(0, 60), mode: input.mode, claudeSessionId: null, messages: [], running: false, updatedAt: '' };
    all().unshift(session);
  }
  const s = session;
  s.mode = input.mode;
  const now = () => new Date().toISOString();
  s.messages.push({ role: 'user', text: input.text, tools: [], at: now() });
  const reply: MyClaudeMessage = { role: 'assistant', text: '', tools: [], at: now() };
  s.messages.push(reply);
  s.running = true;
  s.updatedAt = now();
  persist();

  const edit = input.mode === 'edit';
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', edit ? 'acceptEdits' : 'default',
    '--allowedTools', [...(edit ? EDIT_TOOLS : READ_TOOLS), TEAM_TOOLS].join(','),
    '--mcp-config', mcpConfigFile(),
    '--append-system-prompt',
    `You are ${settings.name}'s Claude Code, running inside the Claude Link desktop app for the team "${settings.teamName}". ` +
    'The claude-link tools connect you to teammates and their Claudes: use ask_claude to ask another teammate\'s Claude about their code ' +
    '(mode "fix" asks them to change it, which their owner approves), report_status to update the team lead, and the chat tools to message people. ' +
    (edit ? 'You may edit files and run commands in this project.' : 'This session is read-only: do not try to modify files.'),
  ];
  if (s.claudeSessionId) args.push('--resume', s.claudeSessionId);

  const cwd = settings.repoPath && existsSync(settings.repoPath) ? settings.repoPath : homedir();
  const child = spawnClaude(resolveClaudeBin(settings.claudeBin), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  running.set(s.id, child);

  let buf = '';
  let stderr = '';
  let gotResult = false;
  const changed = () => { s.updatedAt = now(); emit({ ...s, messages: [...s.messages] }); };

  const handle = (line: string) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id) s.claudeSessionId = ev.session_id;
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text) reply.text += (reply.text ? '\n\n' : '') + c.text;
        if (c.type === 'tool_use') reply.tools.push(describeTool(c.name, c.input ?? {}));
      }
      changed();
    }
    if (ev.type === 'result') {
      gotResult = true;
      if (ev.is_error || ev.subtype !== 'success') {
        reply.error = true;
        if (!reply.text) reply.text = String(ev.result ?? ev.subtype ?? 'Claude stopped with an error.');
      } else if (!reply.text && ev.result) {
        reply.text = String(ev.result);
      }
    }
  };

  child.stdout!.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr!.on('data', d => { stderr = (stderr + d).slice(-3000); });
  const finish = (errText?: string) => {
    if (!s.running) return;
    if (buf) handle(buf);
    if (errText && !reply.text) { reply.text = errText; reply.error = true; }
    if (!gotResult && !reply.text) {
      reply.error = true;
      reply.text = stderr.trim() || 'Claude Code stopped without answering. Is it installed and logged in? Try running `claude` once in a terminal.';
    }
    s.running = false;
    running.delete(s.id);
    persist();
    changed();
  };
  child.on('error', e => finish(`Could not start Claude Code: ${e.message}. Install it from claude.com/claude-code, then restart Claude Link.`));
  child.on('close', () => finish());
  child.stdin!.end(input.text);

  return { ...s };
}

export function stopAllSessions() {
  for (const c of running.values()) c.kill('SIGTERM');
}

app.on('before-quit', stopAllSessions);
