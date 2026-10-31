import type { Config } from './config.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Api = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

export function makeApi(c: Pick<Config, 'hubUrl' | 'token'>, client: 'mcp' | 'agent' | 'cli' = 'cli'): Api {
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetch(new URL(path, c.hubUrl), {
        method,
        headers: {
          authorization: `Bearer ${c.token}`,
          'x-claude-link-client': client,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new ApiError(0, `Cannot reach the Claude Link hub at ${c.hubUrl} (${(e as Error).message}). Is the hub running and are you on the same network?`);
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? String(data));
    return data as any;
  };
}

export const wsUrl = (hubUrl: string, token: string, client: string) => {
  const u = new URL('/ws', hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  u.searchParams.set('client', client);
  return u.toString();
};
