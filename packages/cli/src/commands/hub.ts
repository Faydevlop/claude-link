import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { buildHub, ensureLead, rotateLeadToken } from '../../../hub/src/server.ts';
import { loadOrCreateHubTls } from '../../../hub/src/tls.ts';
import { ensureHome } from '../config.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

const lanAddresses = () =>
  Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i!.address);

export async function hubCommand(opts: { port: string; host: string; name: string; data?: string; rotateLeadToken?: boolean; insecureHttp?: boolean }) {
  const dir = opts.data ?? join(ensureHome(), 'hub');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tls = opts.insecureHttp ? null : loadOrCreateHubTls(dir);
  const hub = buildHub({ dbPath: join(dir, 'hub.db'), webDir, tls });

  let { lead, token } = ensureLead(hub.db, opts.name);
  if (opts.rotateLeadToken) token = rotateLeadToken(hub.db);

  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${opts.port}`);
  const server = await hub.listen(port, opts.host);
  const scheme = tls ? 'https' : 'http';

  const urls = opts.host === '0.0.0.0' ? lanAddresses().map(a => `${scheme}://${a}:${port}`) : [`${scheme}://${opts.host}:${port}`];
  console.log(`\n  Claude Link hub is running`);
  console.log(`  Local:   ${scheme}://127.0.0.1:${port}`);
  for (const u of urls) console.log(`  Network: ${u}   ← share this with your team`);
  if (tls) {
    console.log(`\n  Certificate fingerprint (SHA-256). Teammates compare this when they join:`);
    console.log(`    ${tls.fingerprint}`);
    console.log(`  Browsers warn that the certificate is self-signed; check the fingerprint before continuing.`);
  } else {
    console.log(`\n  ⚠ Running WITHOUT encryption (--insecure-http). Tokens and code travel in the clear on the network.`);
  }
  if (!existsSync(webDir)) console.log(`\n  (web app not built yet — run "npm run build" in the repo to enable the dashboard)`);
  if (token) {
    console.log(`\n  Lead account: ${lead.name}`);
    console.log(`  Lead token (shown once, keep it safe): ${token}`);
    console.log(`\n  Connect your own Claude Code too:`);
    console.log(`    claude-link join ${scheme}://127.0.0.1:${port} --token <lead-token> --repo <path-to-your-repo>`);
  } else {
    console.log(`\n  Lead: ${lead.name}. Lost your token? Restart with --rotate-lead-token.`);
  }
  console.log(`\n  Add teammates from the dashboard: Members → Add member.\n`);

  const shutdown = async () => { await server.close(); hub.db.sql.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', e => console.error('Unhandled error:', e instanceof Error ? e.message : e));
}
