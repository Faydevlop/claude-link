import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopEvent, DesktopSettings, DesktopState, Prerequisites } from '../../../shared/src/desktop.ts';
import type { Member, Role } from '../../../shared/src/index.ts';
import { resolveClaudeBin, runClaudeSync } from '../../../cli/src/agent/claudeBin.ts';
import { fixEnvironment } from './env.ts';
import { clearSettings, loadSettings, newSettings, saveSettings, updateSettings } from './settings.ts';
import { hubError, hubRunning, startHub, stopHub } from './hubHost.ts';
import { discoverTeams, lanAddresses, probeHub } from './network.ts';
import { agentLog, agentState, startAgent, stopAgent } from './agentHost.ts';
import { listSessions, removeSession, sendMessage, stopSession } from './myClaude.ts';
import { setClaudeCodeIntegration } from './integration.ts';

// Lets one machine run several identities while testing: CLAUDE_LINK_PROFILE=bob.
if (process.env.CLAUDE_LINK_PROFILE) app.setPath('userData', `${app.getPath('userData')}-${process.env.CLAUDE_LINK_PROFILE}`);
fixEnvironment();

const assets = app.isPackaged ? process.resourcesPath : join(__dirname, '../../build');
const webDir = join(__dirname, '../renderer');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// ---- state broadcast ----

function state(): DesktopState {
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: loadSettings(),
    agent: { ...agentState },
    hub: { running: hubRunning(), error: hubError, addresses: lanAddresses() },
    log: agentLog.slice(-200),
  };
}

const send = (e: DesktopEvent) => win?.webContents.send('desktop:event', e);
let pending: NodeJS.Timeout | null = null;
function changed() {
  // Coalesce bursts of agent events into one UI update.
  if (pending) return;
  pending = setTimeout(() => { pending = null; send({ type: 'state', state: state() }); updateTray(); }, 100);
}

const hooks = { window: () => win, changed, navigate: (tab: string) => send({ type: 'navigate', tab }) };

// ---- window & tray ----

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600, show: false,
    title: 'Claude Link',
    backgroundColor: '#fafaf9',
    icon: join(assets, 'icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Started at login: stay in the tray until the user opens the window.
  const startHidden = process.argv.includes('--hidden') && !!loadSettings()?.onboarded;
  win.once('ready-to-show', () => { if (!startHidden) win?.show(); });
  win.on('close', e => {
    // Closing the window keeps Claude Link running in the tray so teammates can still reach you.
    if (!quitting) { e.preventDefault(); win?.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(webDir, 'index.html'));
}

function showWindow() {
  if (!win) createWindow();
  win!.show();
  win!.focus();
}

function updateTray() {
  if (!tray) return;
  const s = loadSettings();
  const status = !s?.onboarded ? 'Not set up'
    : agentState.revoked ? 'Disconnected by lead'
    : agentState.connected ? `Connected to ${s.teamName}` : 'Offline — reconnecting…';
  tray.setToolTip(`Claude Link — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    ...(s?.role === 'lead' ? [{ label: hubRunning() ? `Hosting team on port ${s.port}` : 'Team server stopped', enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Claude Link', click: showWindow },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = process.platform === 'darwin'
    ? nativeImage.createFromPath(join(assets, 'trayTemplate.png'))
    : nativeImage.createFromPath(join(assets, 'tray.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', showWindow);
  updateTray();
}

// ---- lifecycle helpers ----

async function startServices(s: DesktopSettings) {
  if (s.role === 'lead') {
    try { await startHub({ name: s.name, teamName: s.teamName, port: s.port ?? 4545, webDir, needToken: false }); }
    catch { changed(); return; }
  }
  if (s.onboarded) startAgent(s, hooks);
  changed();
}

const memberSettings = (hubUrl: string, token: string, me: Member, teamName: string) =>
  newSettings({ role: me.isLead ? 'lead' : 'member', hubUrl, token, memberId: me.id, name: me.name, teamName });

async function fetchMe(hubUrl: string, token: string): Promise<Member> {
  const res = await fetch(new URL('/api/me', hubUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (res.status === 401) throw new Error('That token was not accepted. Ask your team lead for a new one.');
  if (!res.ok) throw new Error(`The team server answered with an error (${res.status}).`);
  return res.json() as Promise<Member>;
}

let joinAttempt: { hubUrl: string; requestId: number; secret: string; teamName: string } | null = null;

// ---- IPC ----

function registerIpc() {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  handle('state:get', () => state());

  handle('setup:prereqs', (): Prerequisites => {
    const claudePath = resolveClaudeBin(loadSettings()?.claudeBin);
    let claudeVersion: string | null = null;
    try { claudeVersion = runClaudeSync(['--version'], claudePath).split('\n')[0] ?? null; } catch { /* missing */ }
    let gitVersion: string | null = null;
    try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* missing */ }
    return { claude: { ok: !!claudeVersion, version: claudeVersion, path: claudePath }, git: { ok: !!gitVersion, version: gitVersion } };
  });

  handle('setup:discover', () => discoverTeams());
  handle('setup:probe', (url: string) => probeHub(url));

  handle('setup:createTeam', async (input: { name: string; teamName: string; port: number }) => {
    const { token, leadId } = await startHub({ ...input, webDir, needToken: true });
    const s = newSettings({
      role: 'lead', hubUrl: `http://127.0.0.1:${input.port}`, token: token!, memberId: leadId,
      name: input.name, teamName: input.teamName, port: input.port,
    });
    saveSettings(s);
    changed();
    return state();
  });

  handle('setup:requestJoin', async (input: { hubUrl: string; name: string; role: Role }) => {
    const team = await probeHub(input.hubUrl);
    const res = await fetch(new URL('/api/join-requests', team.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, role: input.role, device: (await import('node:os')).hostname(), os: process.platform }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as { requestId?: number; secret?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    joinAttempt = { hubUrl: team.url, requestId: data.requestId!, secret: data.secret!, teamName: team.team };
    return { requestId: data.requestId };
  });

  handle('setup:pollJoin', async () => {
    if (!joinAttempt) return { status: 'none' };
    const { hubUrl, requestId, secret, teamName } = joinAttempt;
    const res = await fetch(new URL(`/api/join-requests/${requestId}?secret=${encodeURIComponent(secret)}`, hubUrl), { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as { status: 'pending' | 'approved' | 'rejected' | 'claimed'; token?: string; member?: Member };
    if (data.status === 'approved' && data.token && data.member) {
      saveSettings(memberSettings(hubUrl, data.token, data.member, teamName));
      joinAttempt = null;
      changed();
    }
    if (data.status === 'rejected') joinAttempt = null;
    return { status: data.status, member: data.member };
  });

  handle('setup:joinWithToken', async (input: { hubUrl: string; token: string }) => {
    const team = await probeHub(input.hubUrl);
    const me = await fetchMe(team.url, input.token.trim());
    saveSettings(memberSettings(team.url, input.token.trim(), me, team.team));
    changed();
    return state();
  });

  handle('setup:pickFolder', async () => {
    const opts = { title: 'Choose your project folder', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], isGit: existsSync(join(r.filePaths[0], '.git')) };
  });

  handle('settings:update', (patch: Partial<DesktopSettings>) => {
    const before = loadSettings();
    if (!before) throw new Error('Not set up yet');
    if (patch.claudeCodeIntegration !== undefined && patch.claudeCodeIntegration !== before.claudeCodeIntegration) {
      try { setClaudeCodeIntegration(patch.claudeCodeIntegration); }
      catch (e) { throw new Error(`Could not update Claude Code: ${(e as Error).message}`); }
    }
    if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
    const s = updateSettings(patch);
    // The agent reads the project folder at start, so restart it when that changes.
    if (s.onboarded && patch.repoPath !== undefined && patch.repoPath !== before.repoPath) startAgent(s, hooks);
    changed();
    return state();
  });

  handle('setup:finish', () => {
    const s = updateSettings({ onboarded: true });
    startAgent(s, hooks);
    changed();
    return state();
  });

  handle('setup:testNotification', () => {
    if (Notification.isSupported()) new Notification({ title: 'Claude Link', body: 'Notifications are working. You\'ll be alerted when a teammate needs you.' }).show();
  });

  handle('settings:leave', async () => {
    const s = loadSettings();
    stopAgent();
    if (s?.role === 'lead') await stopHub();
    if (s?.claudeCodeIntegration) { try { setClaudeCodeIntegration(false); } catch { /* best effort */ } }
    clearSettings();
    changed();
    return state();
  });

  handle('app:openExternal', (url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });

  handle('myClaude:list', () => listSessions());
  handle('myClaude:send', (input: { sessionId: string | null; text: string; mode: 'ask' | 'edit' }) =>
    sendMessage(input, session => send({ type: 'myClaude', session })));
  handle('myClaude:stop', (id: string) => stopSession(id));
  handle('myClaude:remove', (id: string) => removeSession(id));
}

// ---- boot ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* stay in the tray */ });

  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(join(assets, 'icon.png'));
    registerIpc();
    createWindow();
    createTray();
    const s = loadSettings();
    if (s) await startServices(s);
  });

  app.on('will-quit', () => { stopAgent(); void stopHub(); });
}
