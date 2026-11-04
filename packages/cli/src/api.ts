import { existsSync, readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { configPath } from './config.ts';
import { hubRequest, HubTrustError, pinnedTlsOptions } from './net.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Api = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

type Conn = Pick<Config, 'hubUrl' | 'token' | 'hubCert'>;

/** Re-reads the token from config.json (it may have been replaced by another Claude Link process). */
const freshToken = (c: Conn) => {
  try {
    if (!existsSync(configPath())) return null;
    const saved = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Config>;
    return saved.hubUrl === c.hubUrl && saved.token && saved.token !== c.token ? saved.token : null;
  } catch { return null; }
};

export function makeApi(c: Conn, client: 'mcp' | 'agent' | 'cli' = 'cli', opts: { reloadToken?: boolean } = {}): Api {
  const call = async <T>(method: string, path: string, body: unknown, retried: boolean): Promise<T> => {
    let res;
    try {
      res = await hubRequest(c, method, path, {
        headers: { authorization: `Bearer ${c.token}`, 'x-claude-link-client': client },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e instanceof HubTrustError) throw new ApiError(495, e.message);
      throw new ApiError(0, `Cannot reach the Claude Link hub at ${c.hubUrl} (${(e as Error).message}). Is the hub running and are you on the same network?`);
    }
    const data = res.contentType.includes('json') ? JSON.parse(res.body || 'null') : res.body;
    if (res.status === 401 && opts.reloadToken && !retried) {
      const t = freshToken(c);
      if (t) { c.token = t; return call<T>(method, path, body, true); }
    }
    if (res.status === 426) throw new ApiError(426, 'The team server now requires an encrypted connection. Join the team again to pin its certificate.');
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, (data as { error?: string })?.error ?? String(data));
    return data as T;
  };
  return (method, path, body) => call(method, path, body, false);
}

export const wsUrl = (hubUrl: string, client: string) => {
  const u = new URL('/ws', hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('client', client);
  return u.toString();
};

/** Options for the `ws` client: token in a header (never the URL), pinned certificate for wss. */
export const wsOptions = (c: Conn) => ({
  headers: { authorization: `Bearer ${c.token}` },
  handshakeTimeout: 10_000,
  maxPayload: 16 * 1024 * 1024,
  ...(c.hubUrl.startsWith('https:') && c.hubCert ? pinnedTlsOptions(c.hubCert) : {}),
});
