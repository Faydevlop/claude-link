import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { makeApi, type Api } from '../api.ts';
import { loadConfig } from '../config.ts';
import { WORK_STATES, type Member, type Message, type StatusUpdate, type Task, type Thread } from '../../../shared/src/index.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Accepts a name, a unique name prefix, or a role ("backend", "qa"...). */
async function resolveMember(api: Api, query: string): Promise<Member> {
  const members = await api<Member[]>('GET', '/api/members');
  const q = query.trim().toLowerCase().replace(/^@/, '');
  const byName = members.find(m => m.name.toLowerCase() === q);
  if (byName) return byName;
  const candidates = [members.filter(m => m.role === q), members.filter(m => m.name.toLowerCase().startsWith(q))];
  for (const c of candidates) {
    if (c.length === 1) return c[0]!;
    if (c.length > 1) throw new Error(`"${query}" matches ${c.map(m => m.name).join(', ')}. Use a full name.`);
  }
  throw new Error(`No teammate matches "${query}". Team: ${members.map(m => `${m.name} (${m.role})`).join(', ')}`);
}

const fmtMember = (m: Member) => `${m.name} (${m.role === "lead" ? "team lead" : m.role}) — ${m.online ? '🟢 agent online' : '⚪ offline'}`;

const fmtTask = (t: Task, names: Map<number, string>) => {
  const lines = [`#${t.id} [${t.mode}] ${t.status} — ${t.title}`, `  from ${names.get(t.fromId)} → ${names.get(t.toId)}${t.threadId ? `, thread ${t.threadId}` : ''}`];
  if (t.branch) lines.push(`  branch: ${t.branch}`);
  if (t.result) lines.push(`  ${t.status === 'running' ? 'progress' : 'result'}: ${t.result}`);
  return lines.join('\n');
};

const fmtMessages = (msgs: Message[], names: Map<number, string>) => msgs.map(m => {
  const who = m.authorKind === 'system' ? 'system' : `${names.get(m.authorId ?? -1) ?? 'unknown'}${m.authorKind === 'claude' ? "'s Claude" : ''}`;
  return `[${m.createdAt.slice(0, 16).replace('T', ' ')}] ${who}: ${m.body}`;
}).join('\n\n');

export async function mcpCommand() {
  const config = loadConfig();
  const api = makeApi(config, 'mcp');
  const names = async () => new Map((await api<Member[]>('GET', '/api/members')).map(m => [m.id, m.name]));

  const server = new McpServer({ name: 'claude-link', version: '0.1.0' }, {
    instructions:
      `Claude Link connects you to your team's Claude Code sessions. You are acting for ${config.name}. ` +
      'Use ask_claude to ask a teammate\'s Claude about their part of the codebase (mode "read") or to request a change in their repo (mode "fix", which their owner must approve). ' +
      'Use report_status after meaningful progress so the team lead sees it. Check read_inbox when the user asks about messages.',
  });

  // Wraps handlers so hub errors come back as readable tool errors instead of crashing the server.
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<string>) =>
    server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>) => {
      try { return text(await fn(args)); }
      catch (e) { return { ...text(`Error: ${(e as Error).message}`), isError: true }; }
    }) as never);

  tool('list_team', 'List teammates, their roles, and whether their Claude Link agent is online.', {}, async () => {
    const members = await api<Member[]>('GET', '/api/members');
    return members.map(m => (m.id === config.memberId ? '• (you) ' : '• ') + fmtMember(m)).join('\n');
  });

  tool('report_status', 'Report what you are working on to the team lead. Use after starting, finishing, or getting blocked on work.', {
    state: z.enum(WORK_STATES).describe('working | blocked | done | idle'),
    summary: z.string().describe('One or two sentences: what, and anything the lead should know'),
    task_id: z.number().int().optional().describe('Related Claude Link task, if any'),
  }, async ({ state, summary, task_id }) => {
    await api('POST', '/api/status', { state, summary, taskId: task_id });
    return `Status reported: ${state} — ${summary}`;
  });

  tool('get_team_status', 'Team lead only: everyone\'s latest status, git branch, uncommitted files and recent commits.', {
    member: z.string().optional().describe('Limit to one teammate (name or role)'),
  }, async ({ member }) => {
    const { members, statuses } = await api<{ members: Member[]; statuses: StatusUpdate[] }>('GET', '/api/status');
    const only = member ? await resolveMember(api, member) : null;
    return members.filter(m => !only || m.id === only.id).map(m => {
      const s = statuses.find(x => x.memberId === m.id);
      const lines = [fmtMember(m)];
      lines.push(s ? `  status: ${s.state} — ${s.summary} (${s.createdAt.slice(0, 16).replace('T', ' ')})` : '  status: (none reported)');
      for (const p of m.git?.projects ?? (m.git ? [{ name: '', ...m.git }] : [])) {
        lines.push(`  ${p.name ? `${p.name}: ` : ''}branch ${p.branch}, ${p.dirtyFiles.length} uncommitted file(s)`);
        for (const c of p.recentCommits.slice(0, p.name ? 3 : 5)) lines.push(`    ${c.hash} ${c.subject}`);
      }
      return lines.join('\n');
    }).join('\n\n');
  });

  tool('ask_claude',
    'Send a request to a teammate\'s Claude Code, which runs it in their repo. mode "read": questions answered automatically with read-only access. ' +
    'mode "fix": edits made on a new git branch after the owner approves. Pass thread_id to follow up in the same conversation (keeps their context).', {
      member: z.string().describe('Teammate name or role, e.g. "backend"'),
      request: z.string().describe('Self-contained question or change request with any needed context'),
      mode: z.enum(['read', 'fix']).default('read'),
      thread_id: z.number().int().optional(),
      wait_seconds: z.number().int().min(0).max(600).optional().describe('How long to wait for the answer (default 120 for read, 0 for fix)'),
    }, async ({ member, request, mode, thread_id, wait_seconds }) => {
      const to = await resolveMember(api, member);
      let task = await api<Task>('POST', '/api/tasks', { toId: to.id, mode, prompt: request, threadId: thread_id });
      const wait = wait_seconds ?? (mode === 'read' ? 120 : 0);
      const deadline = Date.now() + wait * 1000;
      while (Date.now() < deadline && !['done', 'failed', 'rejected'].includes(task.status)) {
        await sleep(2000);
        task = await api<Task>('GET', `/api/tasks/${task.id}`);
      }
      const header = `Task #${task.id} to ${to.name}'s Claude (thread ${task.threadId}) — ${task.status}`;
      if (task.status === 'done') return `${header}\n\n${task.result}${task.branch ? `\n\nChanges are on branch ${task.branch} in ${to.name}'s repo.` : ''}`;
      if (task.status === 'failed') return `${header}\n\n${task.result}`;
      if (task.status === 'pending_approval') return `${header}\nWaiting for ${to.name} to approve. Check later with check_task.`;
      return `${header}\n${to.online ? 'Still working' : `${to.name}'s agent is offline; it will run when they reconnect`}. Check later with check_task(${task.id}).`;
    });

  tool('check_task', 'Get the current status and result of a Claude Link task.', {
    task_id: z.number().int(),
  }, async ({ task_id }) => {
    const t = await api<Task>('GET', `/api/tasks/${task_id}`);
    const out = fmtTask(t, await names());
    return t.diff ? `${out}\n\nDiff:\n${t.diff.slice(0, 20000)}` : out;
  });

  tool('list_tasks', 'List tasks you sent or received (the team lead sees all).', {
    status: z.string().optional().describe('Filter by status, e.g. pending_approval, running, open'),
  }, async ({ status }) => {
    const tasks = (await api<Task[]>('GET', '/api/tasks')).filter(t => !status || t.status === status);
    const n = await names();
    return tasks.length ? tasks.slice(0, 40).map(t => fmtTask(t, n)).join('\n\n') : 'No tasks.';
  });

  tool('assign_task', 'Team lead only: assign a work item to a teammate (tracked, not executed automatically).', {
    member: z.string(),
    title: z.string(),
    details: z.string(),
  }, async ({ member, title, details }) => {
    const to = await resolveMember(api, member);
    const t = await api<Task>('POST', '/api/tasks', { toId: to.id, mode: 'assignment', title, prompt: details });
    return `Assigned task #${t.id} to ${to.name}.`;
  });

  tool('update_task', 'Update an assignment you were given: open, in_progress, blocked, or done.', {
    task_id: z.number().int(),
    status: z.enum(['open', 'in_progress', 'blocked', 'done']),
    note: z.string().optional(),
  }, async ({ task_id, status, note }) => {
    const t = await api<Task>('PATCH', `/api/tasks/${task_id}`, { status, note });
    return `Task #${t.id} is now ${t.status}.`;
  });

  tool('list_threads', 'List conversations: #team channel, direct messages, and Claude-to-Claude threads.', {}, async () => {
    const threads = await api<Thread[]>('GET', '/api/threads');
    return threads.map(t => `${t.id}: [${t.kind}] ${t.kind === 'channel' ? '#' : ''}${t.title}${t.unread ? ` — ${t.unread} unread` : ''}`).join('\n') || 'No threads.';
  });

  tool('read_thread', 'Read the messages in a conversation.', {
    thread_id: z.number().int(),
  }, async ({ thread_id }) => {
    const { thread, messages } = await api<{ thread: Thread; messages: Message[] }>('GET', `/api/threads/${thread_id}/messages`);
    await api('POST', `/api/threads/${thread_id}/read`).catch(() => {});
    return `[${thread.kind}] ${thread.title}\n\n${fmtMessages(messages.slice(-50), await names()) || '(empty)'}`;
  });

  tool('send_message', 'Send a chat message on the user\'s behalf to a teammate (direct message) or to "team" (#team channel).', {
    to: z.string().describe('Teammate name/role, or "team"'),
    text: z.string(),
  }, async ({ to, text: body }) => {
    let threadId: number;
    if (['team', '#team', 'everyone', 'all'].includes(to.trim().toLowerCase())) {
      threadId = (await api<Thread[]>('GET', '/api/threads')).find(t => t.kind === 'channel')!.id;
    } else {
      const m = await resolveMember(api, to);
      threadId = (await api<Thread>('POST', '/api/threads/dm', { memberId: m.id })).id;
    }
    await api('POST', `/api/threads/${threadId}/messages`, { body });
    return `Sent to ${to}.`;
  });

  tool('read_inbox', 'Unread messages, fix requests awaiting your approval, and open assignments. Marks messages as read.', {}, async () => {
    const inbox = await api<{ unread: { thread: Thread; messages: Message[] }[]; approvals: Task[]; assignments: Task[] }>('GET', '/api/inbox');
    const n = await names();
    const parts: string[] = [];
    if (inbox.approvals.length) {
      parts.push('Fix requests waiting for YOUR approval (approve in the web app or the agent terminal):\n' +
        inbox.approvals.map(t => fmtTask(t, n)).join('\n'));
    }
    if (inbox.assignments.length) parts.push('Your open assignments:\n' + inbox.assignments.map(t => fmtTask(t, n)).join('\n'));
    for (const { thread, messages } of inbox.unread) {
      parts.push(`── [${thread.kind}] ${thread.title} (thread ${thread.id})\n${fmtMessages(messages, n)}`);
    }
    if (inbox.unread.length) await api('POST', '/api/inbox/read');
    return parts.join('\n\n') || 'Inbox is empty.';
  });

  await server.connect(new StdioServerTransport());
}
