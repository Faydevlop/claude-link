import type { Member, Role } from './index.ts';

/** Contract between the Electron main process and the UI (exposed as `window.claudeLink`). */

export interface DesktopSettings {
  role: 'lead' | 'member';
  hubUrl: string;
  token: string;
  memberId: number;
  name: string;
  repoPath: string | null;
  teamName: string;
  port?: number;
  autoApproveReads: boolean;
  launchAtLogin: boolean;
  claudeCodeIntegration: boolean;
  onboarded: boolean;
  claudeBin?: string;
  taskTimeoutMinutes?: number;
  fixAllowedTools?: string[];
}

export interface DesktopState {
  version: string;
  platform: string;
  settings: DesktopSettings | null;
  agent: { connected: boolean; revoked: string | null };
  hub: { running: boolean; error: string | null; addresses: string[] };
  log: string[];
}

export interface DiscoveredTeam {
  team: string;
  lead: string | null;
  url: string;
  version: string;
}

export interface Prerequisites {
  claude: { ok: boolean; version: string | null; path: string };
  git: { ok: boolean; version: string | null };
}

export interface MyClaudeMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: string[];
  error?: boolean;
  at: string;
}

export interface MyClaudeSession {
  id: string;
  title: string;
  mode: 'ask' | 'edit';
  claudeSessionId: string | null;
  messages: MyClaudeMessage[];
  running: boolean;
  updatedAt: string;
}

export type DesktopEvent =
  | { type: 'state'; state: DesktopState }
  | { type: 'navigate'; tab: string }
  | { type: 'myClaude'; session: MyClaudeSession };

export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  onEvent(cb: (e: DesktopEvent) => void): () => void;

  checkPrerequisites(): Promise<Prerequisites>;
  discoverTeams(): Promise<DiscoveredTeam[]>;
  probeHub(url: string): Promise<DiscoveredTeam>;
  createTeam(input: { name: string; teamName: string; port: number }): Promise<DesktopState>;
  requestJoin(input: { hubUrl: string; name: string; role: Role }): Promise<{ requestId: number }>;
  pollJoin(): Promise<{ status: 'pending' | 'approved' | 'rejected' | 'claimed' | 'none'; member?: Member }>;
  joinWithToken(input: { hubUrl: string; token: string }): Promise<DesktopState>;
  pickProjectFolder(): Promise<{ path: string; isGit: boolean } | null>;
  updateSettings(patch: Partial<Pick<DesktopSettings, 'repoPath' | 'autoApproveReads' | 'launchAtLogin' | 'claudeCodeIntegration'>>): Promise<DesktopState>;
  finishOnboarding(): Promise<DesktopState>;
  testNotification(): Promise<void>;
  leaveTeam(): Promise<DesktopState>;
  openExternal(url: string): Promise<void>;

  myClaude: {
    list(): Promise<MyClaudeSession[]>;
    send(input: { sessionId: string | null; text: string; mode: 'ask' | 'edit' }): Promise<MyClaudeSession>;
    stop(sessionId: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
  };
}
