export type { Member, Thread, Message, Task, StatusUpdate, AuditEntry, HubEvent, Role, JoinRequest } from '../../shared/src/index.ts';

const TOKEN_KEY = 'claude-link-token';

// In the browser the page is served by the hub itself; the desktop app points this at the hub's address.
let hubBase = typeof location !== 'undefined' && location.protocol.startsWith('http') ? location.origin : '';
export const setHubBase = (url: string) => { hubBase = url.replace(/\/$/, ''); };
export const hubUrl = (path: string) => hubBase + path;
export const hubWsUrl = (path: string) => hubUrl(path).replace(/^http/, 'ws');

// The desktop app keeps the token in its own settings instead of localStorage.
let tokenOverride: string | null = null;
export const setTokenOverride = (t: string | null) => { tokenOverride = t; };

export const getToken = () => { if (tokenOverride) return tokenOverride; try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
};

export async function api<T = any>(method: string, path: string, body?: unknown, token = getToken()): Promise<T> {
  const res = await fetch(hubUrl(path), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const timeAgo = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
