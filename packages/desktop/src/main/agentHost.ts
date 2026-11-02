import { app, dialog, Notification, type BrowserWindow } from 'electron';
import { hostname } from 'node:os';
import { Agent } from '../../../cli/src/agent/core.ts';
import type { Config } from '../../../cli/src/config.ts';
import type { DesktopSettings } from '../../../shared/src/desktop.ts';
import { loadSettings } from './settings.ts';

const MAX_LOG = 300;

export const agentState = { connected: false, revoked: null as string | null };
export const agentLog: string[] = [];
let agent: Agent | null = null;

interface Hooks {
  window: () => BrowserWindow | null;
  changed: () => void;
  navigate: (tab: string) => void;
}

function log(line: string) {
  agentLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (agentLog.length > MAX_LOG) agentLog.splice(0, agentLog.length - MAX_LOG);
}

// Keep notifications referenced until dismissed; a collected one loses its click handler.
const live = new Set<Notification>();

export function notify(title: string, body: string, hooks: Hooks, tab?: string) {
  if (!Notification.isSupported()) { log('Notifications are not supported on this system.'); hooks.changed(); return; }
  const n = new Notification({ title, body, silent: false });
  live.add(n);
  n.on('click', () => {
    const w = hooks.window();
    if (w) { w.show(); w.focus(); }
    if (tab) hooks.navigate(tab);
  });
  n.on('close', () => live.delete(n));
  n.on('failed', (_e, error) => { live.delete(n); log(`Notification failed: ${error}`); hooks.changed(); });
  n.show();
}

const toConfig = (s: DesktopSettings): Config => ({
  hubUrl: s.hubUrl, token: s.token, memberId: s.memberId, name: s.name, repoPath: s.repoPath,
  projects: s.projects, workspaceRoot: s.workspaceRoot,
  claudeBin: s.claudeBin, taskTimeoutMinutes: s.taskTimeoutMinutes, fixAllowedTools: s.fixAllowedTools,
});

export function startAgent(settings: DesktopSettings, hooks: Hooks) {
  stopAgent();
  agentState.revoked = null;
  const a = new Agent(toConfig(settings), {
    device: { name: hostname(), os: process.platform, appVersion: app.getVersion() },
    beforeRun: async (task, requester) => {
      if (loadSettings()?.autoApproveReads !== false) return true;
      const w = hooks.window();
      w?.show();
      const opts = {
        type: 'question' as const, buttons: ['Answer', 'Decline'], defaultId: 0, cancelId: 1,
        title: 'Question from a teammate',
        message: `${requester.name}'s Claude is asking your Claude a question`,
        detail: `${task.prompt}\n\nYour Claude will answer with read-only access to your project.`,
      };
      const { response } = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return response === 0;
    },
  });
  agent = a;

  a.on('log', m => { log(m); hooks.changed(); });
  a.on('connected', () => { agentState.connected = true; log('Connected to the team.'); hooks.changed(); });
  a.on('disconnected', () => { agentState.connected = false; log('Lost connection to the team; reconnecting…'); hooks.changed(); });
  a.on('revoked', reason => {
    agentState.connected = false;
    agentState.revoked = reason || 'removed';
    log(`Disconnected by the team lead (${reason}).`);
    notify('Claude Link', 'You were disconnected from the team by the lead.', hooks);
    hooks.changed();
  });
  a.on('approvalNeeded', (task, from) => {
    log(`Fix request #${task.id} from ${from} needs your approval.`);
    notify(`${from}'s Claude wants to change your code`, `${task.title}\nClick to review and approve.`, hooks, 'requests');
    hooks.changed();
  });
  a.on('taskStarted', (task, from) => { log(`▶ #${task.id} ${task.mode} from ${from}: ${task.title}`); hooks.changed(); });
  a.on('taskProgress', (task, text) => { log(`  · #${task.id} ${text}`); });
  a.on('taskFinished', (task, res) => {
    log(`${res.ok ? '✓' : '✗'} #${task.id} ${res.ok ? 'done' : 'failed'}${res.branch ? ` → branch ${res.branch}` : ''}`);
    if (task.mode === 'fix' && res.ok && res.branch) {
      notify('Fix ready for review', `${task.title}\nBranch ${res.branch} in your project.`, hooks, 'requests');
    }
    hooks.changed();
  });
  a.on('hubEvent', ev => {
    if (ev.type === 'joinRequest.updated' && ev.request.status === 'pending') {
      notify('Someone wants to join your team', `${ev.request.name} (${ev.request.role}) from ${ev.request.device}`, hooks, 'members');
    }
  });

  a.start().catch(e => {
    log(`Could not connect: ${(e as Error).message}`);
    if ((e as { status?: number }).status === 401) agentState.revoked = 'invalid token';
    hooks.changed();
  });
}

export function stopAgent() {
  agent?.removeAllListeners();
  agent?.stop();
  agent = null;
  agentState.connected = false;
}
