import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { buildHub, ensureLead, rotateLeadToken } from '../../../hub/src/server.ts';
import { ensureHome } from '../config.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

const lanAddresses = () =>
  Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i!.address);

export async function hubCommand(opts: { port: string; host: string; name: string; data?: string; rotateLeadToken?: boolean }) {
  const dir = opts.data ?? join(ensureHome(), 'hub');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { app, db } = buildHub({ dbPath: join(dir, 'hub.db'), webDir });

  let { lead, token } = ensureLead(db, opts.name);
  if (opts.rotateLeadToken) token = rotateLeadToken(db);

  const port = Number(opts.port);
  await app.listen({ port, host: opts.host });

  const urls = opts.host === '0.0.0.0' ? lanAddresses().map(a => `http://${a}:${port}`) : [`http://${opts.host}:${port}`];
  console.log(`\n  Claude Link hub is running`);
  console.log(`  Local:   http://127.0.0.1:${port}`);
  for (const u of urls) console.log(`  Network: ${u}   ← share this with your team`);
  if (!existsSync(webDir)) console.log(`\n  (web app not built yet — run "npm run build" in the repo to enable the dashboard)`);
  if (token) {
    console.log(`\n  Lead account: ${lead.name}`);
    console.log(`  Lead token (shown once, keep it safe): ${token}`);
    console.log(`\n  Connect your own Claude Code too:`);
    console.log(`    claude-link join http://127.0.0.1:${port} --token ${token} --repo <path-to-your-repo>`);
  } else {
    console.log(`\n  Lead: ${lead.name}. Lost your token? Restart with --rotate-lead-token.`);
  }
  console.log(`\n  Add teammates from the dashboard: Members → Add member.\n`);

  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
