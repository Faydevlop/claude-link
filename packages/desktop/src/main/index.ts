import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { DesktopEvent, DesktopSettings, DesktopState, Prerequisites } from '../../../shared/src/desktop.ts';
import { ROLES, type Member } from '../../../shared/src/index.ts';
import { resolveClaudeBin, runClaudeSync } from '../../../cli/src/agent/claudeBin.ts';
import { setSelfCommand } from '../../../cli/src/agent/selfCommand.ts';
import { findRepos, uniqueNames } from '../../../cli/src/projects.ts';
import { certFingerprint, fetchHubCertificate, hubRequest } from '../../../cli/src/net.ts';
import { verificationCode } from '../../../hub/src/tls.ts';
import { fixEnvironment } from './env.ts';
import { clearSettings, loadSettings, newSettings, saveSettings, updateSettings } from './settings.ts';
import { hubError, hubRunning, startHub, stopHub } from './hubHost.ts';
import { discoverTeams, lanAddresses, probeHub, seenHub } from './network.ts';
import { agentLog, agentState, decideTask, notify, startAgent, stopAgent } from './agentHost.ts';
import { listSessions, mcpEntry, removeSession, sendMessage, stopSession } from './myClaude.ts';
import { setClaudeCodeIntegration } from './integration.ts';
import { dataDir } from './settings.ts';

// Lets one machine run several identities while testing: CLAUDE_LINK_PROFILE=bob.
if (process.env.CLAUDE_LINK_PROFILE) app.setPath('userData', `${app.getPath('userData')}-${process.env.CLAUDE_LINK_PROFILE}`);
fixEnvironment();
// Windows only shows notifications for apps whose ID matches the installer's Start-menu shortcut.
if (process.platform === 'win32') app.setAppUserModelId('com.claudelink.desktop');

const assets = app.isPackaged ? process.resourcesPath : join(__dirname, '../../build');
const webDir = join(__dirname, '../renderer');
const rendererUrl = app.isPackaged ? null : process.env.ELECTRON_RENDERER_URL ?? null;
const rendererFile = pathToFileURL(join(webDir, 'index.html')).href;

// Claude Link's helper processes (the read-only git server for teammates' requests) run from the bundled entry.
setSelfCommand(sub => ({
  command: process.execPath,
  args: [mcpEntry(), ...(sub[0] === 'git-mcp' ? ['git', ...sub.slice(1)] : sub)],
  env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_LINK_HOME: dataDir() },
}));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// ---- state broadcast ----

function state(): DesktopState {
  const s = loadSettings();
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: s,
    agent: { ...agentState },
    hub: { running: hubRunning(), error: hubError, addresses: lanAddresses() },
    security: { encrypted: !!s?.hubUrl.startsWith('https:') && !!s.hubCert, fingerprint: s?.hubCert ? certFingerprint(s.hubCert) : null },
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

// ---- security for the renderer ----

const normPem = (pem: string) => pem.replace(/-----[^-]+-----|\s+/g, '');

/** The renderer talks to the team server directly; its certificate must be the one pinned at join time. */
function trustPinnedHubCertificate() {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const pinned = loadSettings()?.hubCert;
    if (pinned && normPem(request.certificate.data) === normPem(pinned)) return callback(0);
    callback(-3); // fall back to the normal (CA-based) verification
  });
  // No camera, microphone, geolocation, notifications from the page itself, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/** True only for Claude Link's own page (the bundled file, or the dev server while developing). */
const isAppUrl = (url: string) => {
  try {
    const u = new URL(url);
    if (rendererUrl) { const dev = new URL(rendererUrl); if (u.origin === dev.origin) return true; }
    if (u.protocol !== 'file:') return false;
    const norm = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    return norm(fileURLToPath(u)) === norm(fileURLToPath(rendererFile));
  } catch { return false; }
};

// ---- window & tray ----

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600, show: false,
    title: 'Claude Link',
    backgroundColor: '#fafaf9',
    icon: join(assets, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: true,
    },
  });
  // Started at login: stay in the tray until the user opens the window.
  const startHidden = process.argv.includes('--hidden') && !!loadSettings()?.onboarded;
  win.once('ready-to-show', () => { if (!startHidden) win?.show(); });
  win.on('close', e => {
    // Closing the window keeps Claude Link running in the tray so teammates can still reach you.
    if (!quitting) { e.preventDefault(); win?.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  if (rendererUrl) void win.loadURL(rendererUrl);
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

/**
 * Teams set up before encryption used http://. The lead's own hub now serves https; a member's app pins the
 * certificate the first time it sees it (shown in Settings to compare with the lead).
 */
async function upgradeToEncrypted(s: DesktopSettings): Promise<DesktopSettings> {
  if (s.hubUrl.startsWith('https:') && s.hubCert) return s;
  try {
    const url = new URL(s.hubUrl);
    const httpsUrl = `https://${url.host}`;
    const { cert, fingerprint } = await fetchHubCertificate(httpsUrl, 3000);
    const next = updateSettings({ hubUrl: httpsUrl, hubCert: cert });
    agentLog.push(`[${new Date().toLocaleTimeString()}] Connection to the team is now encrypted. Certificate ${fingerprint}`);
    return next;
  } catch { return s; } // hub not upgraded yet: keep working as before
}

async function startServices(initial: DesktopSettings) {
  let s = initial;
  if (s.role === 'lead') {
    try {
      const h = await startHub({ name: s.name, teamName: s.teamName, port: s.port ?? 4545, webDir, needToken: false });
      if (s.hubUrl !== `https://127.0.0.1:${s.port ?? 4545}` || s.hubCert !== h.cert) {
        s = updateSettings({ hubUrl: `https://127.0.0.1:${s.port ?? 4545}`, hubCert: h.cert });
      }
    } catch { changed(); return; }
  } else {
    s = await upgradeToEncrypted(s);
    if (!s.hubUrl.startsWith('https:')) watchForEncryptedHub();
  }
  if (s.onboarded) startAgent(s, hooks);
  changed();
}

/** The lead may update (and switch the hub to HTTPS) after this app started: keep checking, then reconnect. */
let upgradeTimer: NodeJS.Timeout | null = null;
function watchForEncryptedHub() {
  if (upgradeTimer) return;
  upgradeTimer = setInterval(async () => {
    const current = loadSettings();
    if (!current || current.role === 'lead' || current.hubUrl.startsWith('https:')) { clearInterval(upgradeTimer!); upgradeTimer = null; return; }
    const next = await upgradeToEncrypted(current);
    if (next.hubUrl.startsWith('https:')) {
      clearInterval(upgradeTimer!);
      upgradeTimer = null;
      if (next.onboarded) startAgent(next, hooks);
      changed();
    }
  }, 30_000);
}

const memberSettings = (hubUrl: string, hubCert: string | null, token: string, me: Member, teamName: string) =>
  newSettings({ role: me.isLead ? 'lead' : 'member', hubUrl, hubCert, token, memberId: me.id, name: me.name, teamName });

async function fetchMe(hubUrl: string, hubCert: string | null, token: string): Promise<Member> {
  const res = await hubRequest({ hubUrl, hubCert }, 'GET', '/api/me', { headers: { authorization: `Bearer ${token}` }, timeoutMs: 5000 });
  if (res.status === 401) throw new Error('That token was not accepted. Ask your team lead for a new one.');
  if (res.status !== 200) throw new Error(`The team server answered with an error (${res.status}).`);
  return JSON.parse(res.body) as Member;
}

let joinAttempt: { hubUrl: string; hubCert: string | null; requestId: number; secret: string; teamName: string } | null = null;

// ---- IPC ----

const str = (max: number) => z.string().trim().min(1).max(max);
const schemas = {
  hubAddress: str(300),
  createTeam: z.object({ name: str(60), teamName: str(80), port: z.number().int().min(1024).max(65535) }),
  requestJoin: z.object({ hubUrl: str(300), name: str(60), role: z.enum(ROLES).refine(r => r !== 'lead') }),
  joinWithToken: z.object({ hubUrl: str(300), token: z.string().trim().regex(/^cl_[\w-]{20,100}$/, 'That does not look like a Claude Link token.') }),
  // The renderer may only change these settings. Anything that decides what runs on this computer (the Claude
  // binary, extra tools for fixes, the team server address or token) is not reachable from the UI.
  settingsPatch: z.object({
    projects: z.array(z.object({ name: z.string().max(120), path: z.string().min(1).max(1000) })).max(50).optional(),
    workspaceRoot: z.string().max(1000).nullable().optional(),
    autoApproveReads: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    claudeCodeIntegration: z.boolean().optional(),
  }).strict(),
  sessionId: z.string().uuid(),
  myClaudeSend: z.object({ sessionId: z.string().uuid().nullable(), text: z.string().min(1).max(20_000) }),
  decide: z.object({ taskId: z.number().int().positive(), approve: z.boolean() }),
};

function registerIpc() {
  // Only our own page may call into the main process.
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args) => {
      const url = e.senderFrame?.url ?? '';
      if (!isAppUrl(url)) throw new Error('Blocked: request did not come from Claude Link.');
      return fn(...args);
    });
  const parse = <T extends z.ZodType>(schema: T, v: unknown): z.infer<T> => {
    const r = schema.safeParse(v);
    if (!r.success) throw new Error(r.error.issues[0]?.message ?? 'Invalid input.');
    return r.data as z.infer<T>;
  };

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
  handle('setup:probe', (url: unknown) => probeHub(parse(schemas.hubAddress, url)));

  handle('setup:createTeam', async (raw: unknown) => {
    const input = parse(schemas.createTeam, raw);
    const { token, leadId, cert } = await startHub({ ...input, webDir, needToken: true });
    const s = newSettings({
      role: 'lead', hubUrl: `https://127.0.0.1:${input.port}`, hubCert: cert, token: token!, memberId: leadId,
      name: input.name, teamName: input.teamName, port: input.port,
    });
    saveSettings(s);
    changed();
    return state();
  });

  handle('setup:requestJoin', async (raw: unknown) => {
    const input = parse(schemas.requestJoin, raw);
    const team = await probeHub(input.hubUrl);
    const info = seenHub(team.url);
    const res = await hubRequest({ hubUrl: team.url, hubCert: info?.cert ?? null }, 'POST', '/api/join-requests', {
      body: JSON.stringify({ name: input.name, role: input.role, device: hostname().slice(0, 120), os: process.platform }), timeoutMs: 5000,
    });
    const data = JSON.parse(res.body || '{}') as { requestId?: number; secret?: string; error?: string };
    if (res.status !== 200 || !data.requestId || !data.secret) throw new Error(data.error ?? `Request failed (${res.status})`);
    joinAttempt = { hubUrl: team.url, hubCert: info?.cert ?? null, requestId: data.requestId, secret: data.secret, teamName: team.team };
    // Computed here from the certificate this computer actually saw. If someone sits in the middle, the lead's
    // screen shows a different code.
    return { requestId: data.requestId, verificationCode: verificationCode(info?.fingerprint ?? '', data.secret) };
  });

  handle('setup:pollJoin', async () => {
    if (!joinAttempt) return { status: 'none' };
    const { hubUrl, hubCert, requestId, secret, teamName } = joinAttempt;
    const res = await hubRequest({ hubUrl, hubCert }, 'GET', `/api/join-requests/${requestId}?secret=${encodeURIComponent(secret)}`, { timeoutMs: 5000 });
    const data = JSON.parse(res.body || '{}') as { status: 'pending' | 'approved' | 'rejected' | 'claimed'; token?: string; member?: Member };
    if (data.status === 'approved' && data.token && data.member) {
      saveSettings(memberSettings(hubUrl, hubCert, data.token, data.member, teamName));
      joinAttempt = null;
      changed();
    }
    if (data.status === 'rejected') joinAttempt = null;
    return { status: data.status ?? 'none', member: data.member };
  });

  handle('setup:joinWithToken', async (raw: unknown) => {
    const input = parse(schemas.joinWithToken, raw);
    const team = await probeHub(input.hubUrl);
    const cert = seenHub(team.url)?.cert ?? null;
    const me = await fetchMe(team.url, cert, input.token);
    saveSettings(memberSettings(team.url, cert, input.token, me, team.team));
    changed();
    return state();
  });

  handle('setup:pickFolder', async () => {
    const opts = { title: 'Choose your project folder', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    return { path, isGit: existsSync(join(path, '.git')), repos: findRepos(path) };
  });

  handle('settings:update', (raw: unknown) => {
    let patch: Partial<DesktopSettings> = parse(schemas.settingsPatch, raw);
    const before = loadSettings();
    if (!before) throw new Error('Not set up yet');
    if (patch.claudeCodeIntegration !== undefined && patch.claudeCodeIntegration !== before.claudeCodeIntegration) {
      try { setClaudeCodeIntegration(patch.claudeCodeIntegration); }
      catch (e) { throw new Error(`Could not update Claude Code: ${(e as Error).message}`); }
    }
    if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
    if (patch.projects) {
      const valid = patch.projects.filter(p => existsSync(join(p.path, '.git')));
      if (valid.length !== patch.projects.length) throw new Error('Every project must be a git repository.');
      patch = { ...patch, projects: uniqueNames(valid), repoPath: valid[0]?.path ?? null };
    }
    if (patch.workspaceRoot && !existsSync(patch.workspaceRoot)) throw new Error('That folder no longer exists.');
    const s = updateSettings(patch);
    // The agent reads the projects at start, so restart it when they change.
    const projectsChanged = JSON.stringify([s.projects, s.workspaceRoot]) !== JSON.stringify([before.projects, before.workspaceRoot]);
    if (s.onboarded && projectsChanged) startAgent(s, hooks);
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
    notify('Claude Link', 'Notifications are working. You\'ll be alerted when a teammate needs you.', hooks);
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

  handle('app:openExternal', (url: unknown) => {
    if (typeof url === 'string' && /^https:\/\/[^\s]{1,500}$/.test(url)) void shell.openExternal(url);
  });

  handle('tasks:decide', async (taskId: unknown, approve: unknown) => {
    const d = parse(schemas.decide, { taskId, approve });
    await decideTask(d.taskId, d.approve);
  });

  handle('myClaude:list', () => listSessions());
  handle('myClaude:send', (raw: unknown) => sendMessage(parse(schemas.myClaudeSend, raw), session => send({ type: 'myClaude', session })));
  handle('myClaude:stop', (id: unknown) => stopSession(parse(schemas.sessionId, id)));
  handle('myClaude:remove', (id: unknown) => removeSession(parse(schemas.sessionId, id)));
}

// ---- boot ----

process.on('unhandledRejection', e => { agentLog.push(`[${new Date().toLocaleTimeString()}] Unexpected error: ${e instanceof Error ? e.message : String(e)}`); });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* stay in the tray */ });
  // Every web contents (there is only our window) gets the same restrictions.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', e => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(join(assets, 'icon.png'));
    trustPinnedHubCertificate();
    registerIpc();
    createWindow();
    createTray();
    const s = loadSettings();
    if (s) await startServices(s);
  });

  app.on('will-quit', () => { stopAgent(); void stopHub(); });
}
