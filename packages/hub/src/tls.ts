import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * Self-signed TLS identity for the hub. Teammates pin the certificate's SHA-256 fingerprint when they join
 * (trust on first use, confirmed by a verification code), so no certificate authority is involved and the
 * hub's changing LAN address does not matter.
 *
 * Node can parse but not create X.509 certificates, so this file contains a minimal DER encoder for
 * exactly one certificate shape: ECDSA P-256, SHA-256, v3, CA:TRUE (so it can be its own trust anchor).
 */

export interface HubTls { key: string; cert: string; fingerprint: string }

// ---- minimal DER ----

const len = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a! + b!];
  for (const n of rest) {
    const enc = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

const ipBytes = (ip: string) => Buffer.from(ip.split('.').map(Number));

/** Creates a new self-signed certificate valid for ten years. */
export function generateHubTls(commonName = 'Claude Link hub'): HubTls {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName.slice(0, 64)))));
  const serial = randomBytes(16); serial[0]! &= 0x7f;
  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now.getTime() + 3650 * 24 * 3600_000);

  // Subject alternative names: browsers still warn (the cert is self-signed) but at least the names match.
  const ips = ['127.0.0.1', ...Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address)];
  const san = seq(tlv(0x82, Buffer.from('localhost')), ...[...new Set(ips)].map(ip => tlv(0x87, ipBytes(ip))));

  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),                         // version v3
    int(serial),
    seq(oid(ECDSA_SHA256)),
    name,                                                     // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,                                                     // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(
      ext('2.5.29.19', true, seq(bool(true))),                // basicConstraints: CA (own trust anchor)
      ext('2.5.29.15', true, bits(Buffer.from([0x84]), 2)),   // keyUsage: digitalSignature, keyCertSign
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      ext('2.5.29.17', false, san),
    )),
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), bits(signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { key, cert, fingerprint: certFingerprint(cert) };
}

/** SHA-256 over the DER certificate, as lowercase hex with colons (the same as `openssl x509 -fingerprint -sha256`). */
export function certFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.toLowerCase();
}

export const fingerprintOfDer = (der: Buffer) => createHash('sha256').update(der).digest('hex').match(/../g)!.join(':');

/** Loads the hub's certificate from `dir`, creating it on first use. The private key is written owner-only. */
export function loadOrCreateHubTls(dir: string): HubTls {
  const keyFile = join(dir, 'hub-key.pem');
  const certFile = join(dir, 'hub-cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    const key = readFileSync(keyFile, 'utf8');
    const cert = readFileSync(certFile, 'utf8');
    createPrivateKey(key); // throws if corrupt
    return { key, cert, fingerprint: certFingerprint(cert) };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tls = generateHubTls();
  writeFileSync(keyFile, tls.key, { mode: 0o600 });
  writeFileSync(certFile, tls.cert, { mode: 0o644 });
  return tls;
}

/**
 * Short code derived from the hub's certificate and the join request's secret. The requester computes it from
 * the certificate it actually saw; the hub from its own. Different codes mean someone is in the middle.
 */
export function verificationCode(fingerprint: string, secret: string): string {
  const h = createHash('sha256').update(`claude-link-join-v1|${fingerprint.toLowerCase()}|${secret}`).digest();
  const n = h.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0').replace(/^(\d{3})/, '$1 ');
}
