import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHub, ensureLead } from '../../hub/src/server.ts';
import { generateHubTls, type HubTls } from '../../hub/src/tls.ts';
import { Agent } from '../src/agent/core.ts';
import { makeApi } from '../src/api.ts';
import { fetchHubCertificate, hubRequest, HubTrustError, probeHubAddress } from '../src/net.ts';
import type { Config } from '../src/config.ts';
import type { Task } from '../../shared/src/index.ts';
import { installFakeClaude } from './fakeClaude.ts';

/**
 * The real pieces together: an HTTPS hub, agents that pinned its certificate, and a stand-in for Claude Code.
 */

let dir: string;
let tls: HubTls;
let hub: ReturnType<typeof buildHub>;
let server: { port: number; close: () => Promise<void> };
let leadToken: string;
const agents: Agent[] = [];
const savedHome = process.env.CLAUDE_LINK_HOME;

const hubUrl = () => `https://127.0.0.1:${server.port}`;
const lead = () => makeApi({ hubUrl: hubUrl(), token: leadToken, hubCert: tls.cert });

const startHub = async (port = 0) => {
  hub = buildHub({ dbPath: join(dir, 'hub.db'), tls });
  leadToken ??= ensureLead(hub.db, 'Lead').token!;
  server = await hub.listen(port, '127.0.0.1');
};

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 100));
  }
};

const repo = (path: string) => {
  mkdirSync(path, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: path, stdio: 'ignore' });
  g('init', '-q');
  writeFileSync(join(path, 'app.txt'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
};

const member = async (name: string): Promise<{ id: number; config: Config; api: ReturnType<typeof makeApi> }> => {
  const { member: m, token } = await lead()<{ member: { id: number }; token: string }>('POST', '/api/members', { name, role: 'backend' });
  const project = join(dir, name.toLowerCase());
  repo(project);
  const config: Config = {
    hubUrl: hubUrl(), hubCert: tls.cert, token, memberId: m.id, name, claudeBin: installFakeClaude(dir),
    repoPath: project, projects: [{ name: 'app', path: project }],
  };
  return { id: m.id, config, api: makeApi(config) };
};

const startAgent = (config: Config, opts: ConstructorParameters<typeof Agent>[1] = {}) => {
  const a = new Agent(config, opts);
  agents.push(a);
  const connected = new Promise<void>(r => a.once('connected', r));
  void a.start();
  return { agent: a, connected };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-link-e2e-'));
  process.env.CLAUDE_LINK_HOME = join(dir, 'home');
  tls = generateHubTls();
  leadToken = undefined as unknown as string;
  await startHub();
});

afterEach(async () => {
  for (const a of agents.splice(0)) a.stop();
  await server.close();
  hub.db.sql.close();
  process.env.CLAUDE_LINK_HOME = savedHome;
});

describe('encrypted connection', { timeout: 30_000 }, () => {
  it('pins the hub certificate on first contact and uses it afterwards', async () => {
    const info = await probeHubAddress(`127.0.0.1:${server.port}`);
    expect(info).toMatchObject({ tls: true, url: hubUrl(), fingerprint: tls.fingerprint });
    expect((await lead()<{ name: string }>('GET', '/api/me')).name).toBe('Lead');
  });

  it('refuses an impostor before sending anything secret', async () => {
    // Someone else on the network answers with their own certificate.
    const rogue = generateHubTls();
    const seen: string[] = [];
    const impostor = createHttpsServer({ key: rogue.key, cert: rogue.cert }, (req, res) => { seen.push(String(req.headers.authorization)); res.end('{}'); });
    await new Promise<void>(r => impostor.listen(0, '127.0.0.1', r));
    const port = (impostor.address() as { port: number }).port;
    const api = makeApi({ hubUrl: `https://127.0.0.1:${port}`, token: leadToken, hubCert: tls.cert });
    await expect(api('GET', '/api/me')).rejects.toThrow(/different certificate/);
    await expect(hubRequest({ hubUrl: `https://127.0.0.1:${port}`, hubCert: tls.cert }, 'GET', '/api/me')).rejects.toBeInstanceOf(HubTrustError);
    expect(seen).toEqual([]); // the token never reached the impostor
    expect((await fetchHubCertificate(`https://127.0.0.1:${port}`)).fingerprint).toBe(rogue.fingerprint);
    impostor.close();
  });

  it('answers plain HTTP with a redirect or an upgrade hint, never with data', async () => {
    const get = (path: string) => new Promise<{ status: number; location?: string }>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: server.port, path, headers: { authorization: `Bearer ${leadToken}` } }, res => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      }).on('error', reject).end();
    });
    expect(await get('/api/me')).toMatchObject({ status: 426 });
    expect(await get('/')).toMatchObject({ status: 301, location: `https://127.0.0.1:${server.port}/` });
  });
});

describe('agents end to end', { timeout: 60_000 }, () => {
  it('answers a question and runs a fix only after its owner approves it on their own machine', async () => {
    const ana = await member('Ana');
    const ben = await member('Ben');
    const { agent, connected } = startAgent(ben.config);
    agent.on('approvalNeeded', task => void agent.decide(task.id, true));
    await connected;

    const q = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'read', prompt: 'What does /login return?' });
    const answered = await until(async () => { const t = await ana.api<Task>('GET', `/api/tasks/${q.id}`); return t.status === 'done' && t; });
    expect(JSON.parse(answered.result!).argv).toContain('--restricted');

    const fix = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'fix', prompt: 'Fix the greeting' });
    const done = await until(async () => { const t = await ana.api<Task>('GET', `/api/tasks/${fix.id}`); return t.status === 'done' && t; });
    expect(done).toMatchObject({ branch: `claude-link/task-${fix.id}`, approvedBy: ben.id });
    expect(done.diff).toContain('+hello fixed');
    // Nothing was merged: the owner's checkout is unchanged.
    expect(execFileSync('git', ['show', 'HEAD:app.txt'], { cwd: join(dir, 'ben'), encoding: 'utf8' })).toBe('hello\n');
  });

  it('refuses a fix that the hub marks approved without the owner approving it on this machine', async () => {
    const ana = await member('Ana');
    const ben = await member('Ben');
    const { agent, connected } = startAgent(ben.config); // no confirmFix hook: nobody can confirm here
    await connected;
    const fix = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'fix', prompt: 'Change stuff' });
    // Approved through the hub API (as the web page would), not through this machine's agent.
    await ben.api('POST', `/api/tasks/${fix.id}/approve`, {});
    const final = await until(async () => { const t = await ana.api<Task>('GET', `/api/tasks/${fix.id}`); return t.status === 'rejected' && t; });
    expect(final.result).toMatch(/not approved on this computer/);
    expect(final.branch).toBeNull();
    agent.stop();
  });

  it('asks its owner when a fix was approved elsewhere, and runs it if they confirm', async () => {
    const ana = await member('Ana');
    const ben = await member('Ben');
    let asked = 0;
    const { connected } = startAgent(ben.config, { confirmFix: async () => { asked++; return true; } });
    await connected;
    const fix = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'fix', prompt: 'Fix the greeting' });
    await ben.api('POST', `/api/tasks/${fix.id}/approve`, {});
    await until(async () => (await ana.api<Task>('GET', `/api/tasks/${fix.id}`)).status === 'done');
    expect(asked).toBe(1);
  });

  it('runs each task once even with two agents for the same person', async () => {
    const ana = await member('Ana');
    const ben = await member('Ben');
    let started = 0;
    const one = startAgent(ben.config);
    const two = startAgent({ ...ben.config });
    for (const a of [one.agent, two.agent]) a.on('taskStarted', () => { started++; });
    await Promise.all([one.connected, two.connected]);
    const q = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'read', prompt: 'q' });
    await until(async () => (await ana.api<Task>('GET', `/api/tasks/${q.id}`)).status === 'done');
    // Reconnecting re-dispatches queued tasks; give a duplicate the chance to show up.
    await new Promise(r => setTimeout(r, 500));
    expect(started).toBe(1);
  });

  it('reconnects after the hub restarts and keeps working', async () => {
    const ana = await member('Ana');
    const ben = await member('Ben');
    const { agent, connected } = startAgent(ben.config);
    await connected;
    const port = server.port;
    const reconnected = new Promise<void>(r => agent.once('connected', r));
    await server.close();
    hub.db.sql.close();
    await startHub(port);
    await reconnected;
    const q = await ana.api<Task>('POST', '/api/tasks', { toId: ben.id, mode: 'read', prompt: 'still there?' });
    await until(async () => (await ana.api<Task>('GET', `/api/tasks/${q.id}`)).status === 'done');
  });

  it('a removed member\'s agent is cut off immediately', async () => {
    const ben = await member('Ben');
    const { agent, connected } = startAgent(ben.config);
    await connected;
    const revoked = new Promise<string>(r => agent.once('revoked', r));
    await lead()('DELETE', `/api/members/${ben.id}`);
    expect(await revoked).toBe('removed');
    await expect(ben.api('GET', '/api/me')).rejects.toThrow(/invalid or missing token/);
  });
});

// Keeps the unused-import linter honest about the plain-HTTP helper above.
void createServer;
