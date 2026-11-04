import { z } from 'zod';

export const ROLES = ['lead', 'qa', 'frontend', 'backend', 'ai', 'other'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What a member may do on the team. The lead is always `admin`.
 * - developer: chat, ask questions, send fix requests, receive tasks.
 * - viewer: chat and ask read-only questions; cannot send fix requests.
 */
export const ACCESS_LEVELS = ['admin', 'developer', 'viewer'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export const WORK_STATES = ['idle', 'working', 'blocked', 'done'] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const TASK_MODES = ['read', 'fix', 'assignment'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

// read/fix tasks move through the execution states; assignments use the tracking states.
export const TASK_STATUSES = [
  'pending_approval', 'queued', 'running', 'done', 'rejected', 'failed',
  'open', 'in_progress', 'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ThreadKind = 'dm' | 'channel' | 'claude';
export type AuthorKind = 'human' | 'claude' | 'system';

export interface Project {
  name: string;
  path: string;
}

export interface RepoState {
  branch: string;
  dirtyFiles: string[];
  recentCommits: { hash: string; subject: string; at: string }[];
}

/** The first project's state at the top level; every project (when there are several) under `projects`. */
export interface GitState extends RepoState {
  projects?: (RepoState & { name: string })[];
}

export interface Presence {
  ip: string;
  device: string;
  os: string;
  appVersion: string;
  connectedSince: string;
}

export interface Member {
  id: number;
  name: string;
  role: Role;
  isLead: boolean;
  access: Access;
  online: boolean;
  lastSeen: string | null;
  repoPath: string | null;
  git: GitState | null;
  /** Set while the member's agent is connected. */
  presence: Presence | null;
  lastDisconnectedAt: string | null;
}

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'claimed';

export interface JoinRequest {
  id: number;
  name: string;
  role: Role;
  device: string;
  os: string;
  ip: string;
  status: JoinRequestStatus;
  memberId: number | null;
  /** Short code shown on both the requester's and the lead's screen; they must match. */
  verificationCode: string | null;
  createdAt: string;
}

export interface StatusUpdate {
  id: number;
  memberId: number;
  state: WorkState;
  summary: string;
  taskId: number | null;
  createdAt: string;
}

export interface Thread {
  id: number;
  kind: ThreadKind;
  title: string;
  participantIds: number[];
  createdBy: number | null;
  createdAt: string;
  lastMessageAt: string | null;
  unread: number;
}

export interface Message {
  id: number;
  threadId: number;
  authorId: number | null;
  authorKind: AuthorKind;
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface Task {
  id: number;
  fromId: number;
  toId: number;
  mode: TaskMode;
  status: TaskStatus;
  title: string;
  prompt: string;
  result: string | null;
  diff: string | null;
  branch: string | null;
  threadId: number | null;
  /** Fix tasks: who approved, when, and a hash of the exact request they approved. */
  approvedBy: number | null;
  approvedAt: string | null;
  approvalHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  actorId: number | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

// Events pushed over the hub WebSocket.
export type HubEvent =
  | { type: 'hello'; me: Member }
  | { type: 'member.updated'; member: Member }
  | { type: 'member.removed'; memberId: number }
  | { type: 'status.updated'; status: StatusUpdate }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'message.created'; message: Message }
  | { type: 'task.updated'; task: Task }
  | { type: 'joinRequest.updated'; request: JoinRequest }
  // Sent to the target agent only: execute this task now.
  | { type: 'task.run'; task: Task; requester: Pick<Member, 'id' | 'name' | 'role'>; resumeSessionId: string | null };

const taskShape = z.object({
  id: z.number().int().positive(), fromId: z.number().int(), toId: z.number().int(),
  mode: z.enum(TASK_MODES), status: z.enum(TASK_STATUSES),
  title: z.string().max(400), prompt: z.string().max(20000),
  result: z.string().nullable(), diff: z.string().nullable(), branch: z.string().nullable(), threadId: z.number().int().nullable(),
  approvedBy: z.number().int().nullable().optional(), approvedAt: z.string().nullable().optional(), approvalHash: z.string().nullable().optional(),
  createdAt: z.string(), updatedAt: z.string(),
});

/**
 * The only hub events an agent acts on. Agents validate them before doing anything: a hub (or anything
 * pretending to be one) is treated as untrusted input.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.run'),
    task: taskShape,
    requester: z.object({ id: z.number().int(), name: z.string().max(60), role: z.enum(ROLES) }),
    resumeSessionId: z.string().max(200).regex(/^[\w-]+$/).nullable(),
  }),
  z.object({ type: z.literal('task.updated'), task: taskShape }),
]);

// ---- Request bodies ----

export const createMemberBody = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(ROLES).refine(r => r !== 'lead', 'there is only one team lead'),
  access: z.enum(['developer', 'viewer']).optional(),
});

export const updateMemberBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  role: z.enum(ROLES).refine(r => r !== 'lead', 'there is only one team lead').optional(),
  access: z.enum(['developer', 'viewer']).optional(),
});

export const teamSettingsBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Tokens unused for this many days stop working (0 = never). The lead's own token is exempt. */
  tokenIdleDays: z.number().int().min(0).max(3650).optional(),
});

export const statusBody = z.object({
  state: z.enum(WORK_STATES),
  summary: z.string().trim().min(1).max(2000),
  taskId: z.number().int().optional(),
});

const repoStateShape = {
  branch: z.string().max(300),
  dirtyFiles: z.array(z.string().max(1000)).max(500),
  recentCommits: z.array(z.object({ hash: z.string().max(64), subject: z.string().max(500), at: z.string().max(40) })).max(20),
};

export const gitStateBody = z.object({
  repoPath: z.string().max(1000).optional(),
  ...repoStateShape,
  projects: z.array(z.object({ name: z.string().max(120), ...repoStateShape })).max(50).optional(),
});

export const openDmBody = z.object({ memberId: z.number().int() });

export const postMessageBody = z.object({ body: z.string().trim().min(1).max(20000) });

export const createTaskBody = z.object({
  toId: z.number().int(),
  mode: z.enum(TASK_MODES),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20000),
  // Continue an existing Claude-to-Claude thread (keeps the remote Claude's context).
  threadId: z.number().int().optional(),
});

export const updateTaskBody = z.object({
  status: z.enum(['open', 'in_progress', 'blocked', 'done']).optional(),
  note: z.string().trim().max(5000).optional(),
});

export const taskProgressBody = z.object({ text: z.string().max(5000) });

export const taskCompleteBody = z.object({
  ok: z.boolean(),
  result: z.string().max(100000),
  diff: z.string().max(400000).optional(),
  branch: z.string().max(300).optional(),
  sessionId: z.string().max(200).optional(),
});

export const claimTaskBody = z.object({
  /** Fix tasks: the agent's own hash of what its owner approved; must match the hub's record. */
  approvalHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const joinRequestBody = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(ROLES).refine(r => r !== 'lead', 'cannot request the lead role'),
  device: z.string().trim().max(120).default('unknown device'),
  os: z.string().trim().max(40).default('unknown'),
});
