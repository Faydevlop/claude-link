import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';

/**
 * Talking to the hub. With an https:// hub, every connection is verified against the hub certificate that was
 * pinned when this machine joined: the handshake fails before any request (and so any token) is sent if the
 * certificate is different. Plain http:// is only used for hubs that were explicitly started without TLS.
 */

export interface HubTrust {
  hubUrl: string;
  /** PEM of the hub's certificate, pinned at join time. */
  hubCert?: string | null;
}

export interface HttpResult { status: number; contentType: string; body: string }

export class HubTrustError extends Error {}

/** TLS options that accept exactly the pinned certificate, whatever address the hub currently has. */
export function pinnedTlsOptions(cert: string): tls.ConnectionOptions {
  return { ca: [cert], checkServerIdentity: () => undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

export const certFingerprint = (pem: string) => new X509Certificate(pem).fingerprint256.toLowerCase();

const toPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * Trust on first use: reads the certificate a hub presents without trusting it yet. The caller must show the
 * fingerprint (or a verification code derived from it) so a person can compare it with the lead's screen.
 * Nothing secret is sent on this connection.
 */
export function fetchHubCertificate(hubUrl: string, timeoutMs = 5000): Promise<{ cert: string; fingerprint: string }> {
  const u = new URL(hubUrl);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false,
      ...(isIP(u.hostname) ? {} : { servername: u.hostname }),
    }, () => {
      const peer = socket.getPeerCertificate(true);
      socket.end();
      if (!peer?.raw) return reject(new Error('The team server did not present a certificate.'));
      const cert = toPem(peer.raw);
      resolve({ cert, fingerprint: certFingerprint(cert) });
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timed out')));
    socket.on('error', reject);
  });
}

/** One HTTP(S) request to the hub. Refuses https without a pinned certificate unless `unpinned` is set (public, secret-free calls only). */
export function hubRequest(trust: HubTrust, method: string, path: string, opts: {
  headers?: Record<string, string>; body?: string; timeoutMs?: number; unpinned?: boolean;
} = {}): Promise<HttpResult> {
  const url = new URL(path, trust.hubUrl);
  const secure = url.protocol === 'https:';
  if (secure && !trust.hubCert && !opts.unpinned) {
    return Promise.reject(new HubTrustError('This team server\'s certificate is not pinned on this computer. Join the team again.'));
  }
  const lib = secure ? https : http;
  const tlsOpts = secure ? (trust.hubCert ? pinnedTlsOptions(trust.hubCert) : { rejectUnauthorized: false }) : {};
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method, ...tlsOpts, agent: false,
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(opts.body)) } : {}), ...opts.headers },
      timeout: opts.timeoutMs ?? 15_000,
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (secure && trust.hubCert && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|SIGNATURE/i.test(code + e.message)) {
        reject(new HubTrustError('The team server presented a different certificate than the one this computer trusts. ' +
          'If the lead reinstalled Claude Link, join again; otherwise someone on the network may be impersonating it.'));
      } else reject(e);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface HubInfo {
  url: string;
  team: string;
  lead: string | null;
  version: string;
  tls: boolean;
  /** Present for https hubs: what this computer actually saw. */
  cert: string | null;
  fingerprint: string | null;
}

/**
 * Finds the hub at an address the user typed ("192.168.1.5", "192.168.1.5:4545", "https://…").
 * Prefers https; falls back to plain http only for hubs that do not speak TLS (older versions or --insecure-http).
 */
export async function probeHubAddress(input: string, timeoutMs = 4000): Promise<HubInfo> {
  let base = input.trim();
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const u = new URL(base);
  if (!u.port) u.port = '4545';
  const tryHealth = async (url: string, cert: string | null) => {
    const r = await hubRequest({ hubUrl: url, hubCert: cert }, 'GET', '/api/health', { timeoutMs, unpinned: !cert });
    const h = JSON.parse(r.body || '{}') as { name?: string; team?: string; lead?: string; version?: string; https?: boolean };
    return { status: r.status, h };
  };
  const httpsUrl = `https://${u.host}`;
  try {
    const { cert, fingerprint } = await fetchHubCertificate(httpsUrl, timeoutMs);
    const { h } = await tryHealth(httpsUrl, cert);
    if (h.name !== 'claude-link') throw new Error(`${u.host} is not a Claude Link team.`);
    return { url: httpsUrl, team: h.team ?? 'Claude Link team', lead: h.lead ?? null, version: h.version ?? '?', tls: true, cert, fingerprint };
  } catch (e) {
    if ((e as Error).message.includes('not a Claude Link team')) throw e;
    // Not TLS: maybe an older (or deliberately unencrypted) hub.
    const httpUrl = `http://${u.host}`;
    let res;
    try { res = await tryHealth(httpUrl, null); }
    catch { throw new Error(`No Claude Link team answered at ${u.host}. Check the address and that you're on the same network.`); }
    if (res.h.name !== 'claude-link') throw new Error(`${u.host} is not a Claude Link team.`);
    return { url: httpUrl, team: res.h.team ?? 'Claude Link team', lead: res.h.lead ?? null, version: res.h.version ?? '?', tls: false, cert: null, fingerprint: null };
  }
}
