import type { Member, Project, Role } from './index.ts';

/** Contract between the Electron main process and the UI (exposed as `window.claudeLink`). */

export interface DesktopSettings {
  role: 'lead' | 'member';
  hubUrl: string;
  token: string;
  /** PEM of the hub's TLS certificate, pinned when this computer joined (https hubs). */
  hubCert?: string | null;
  memberId: number;
  name: string;
  /** First project; kept in sync with `projects` for older readers. */
  repoPath: string | null;
  projects: Project[];
  /** Folder the projects were picked from (multiple-projects mode), or null for a single project. */
  workspaceRoot: string | null;
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
  /** How this computer talks to the team server. */
  security: { encrypted: boolean; fingerprint: string | null };
  log: string[];
}

export interface DiscoveredTeam {
  team: string;
  lead: string | null;
  url: string;
  version: string;
  encrypted: boolean;
  /** SHA-256 of the certificate this computer saw (https hubs). */
  fingerprint: string | null;
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
  /** `verificationCode` must match the code on the lead's screen before they approve. */
  requestJoin(input: { hubUrl: string; name: string; role: Role }): Promise<{ requestId: number; verificationCode: string }>;
  pollJoin(): Promise<{ status: 'pending' | 'approved' | 'rejected' | 'claimed' | 'none'; member?: Member }>;
  joinWithToken(input: { hubUrl: string; token: string }): Promise<DesktopState>;
  /** Opens a folder picker; `repos` lists the git repositories found at or inside the folder. */
  pickProjectFolder(): Promise<{ path: string; isGit: boolean; repos: Project[] } | null>;
  updateSettings(patch: Partial<Pick<DesktopSettings, 'projects' | 'workspaceRoot' | 'autoApproveReads' | 'launchAtLogin' | 'claudeCodeIntegration'>>): Promise<DesktopState>;
  finishOnboarding(): Promise<DesktopState>;
  testNotification(): Promise<void>;
  leaveTeam(): Promise<DesktopState>;
  openExternal(url: string): Promise<void>;
  /** Approve or reject a fix aimed at this computer. Recorded here first, then sent to the team server. */
  decideTask(taskId: number, approve: boolean): Promise<void>;

  myClaude: {
    list(): Promise<MyClaudeSession[]>;
    send(input: { sessionId: string | null; text: string }): Promise<MyClaudeSession>;
    stop(sessionId: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
  };
}
