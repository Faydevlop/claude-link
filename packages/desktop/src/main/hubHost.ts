import { join } from 'node:path';
import { buildHub, ensureLead, rotateLeadToken } from '../../../hub/src/server.ts';
import { loadOrCreateHubTls, type HubTls } from '../../../hub/src/tls.ts';
import { dataDir } from './settings.ts';
import { advertise, stopAdvertising } from './network.ts';

type Hub = ReturnType<typeof buildHub>;
let hub: Hub | null = null;
let server: { port: number; close: () => Promise<void> } | null = null;
export let hubError: string | null = null;
export let hubTls: HubTls | null = null;

export const hubRunning = () => !!hub;

/**
 * Starts the team hub inside the app (lead only), over HTTPS with this computer's own certificate.
 * Returns the lead token when the team was just created.
 */
export async function startHub(opts: { name: string; teamName: string; port: number; webDir: string; needToken: boolean }): Promise<{ token: string | null; leadId: number; cert: string; fingerprint: string }> {
  if (hub) await stopHub();
  hubError = null;
  hubTls = loadOrCreateHubTls(join(dataDir(), 'tls'));
  const h = buildHub({ dbPath: join(dataDir(), 'hub.db'), webDir: opts.webDir, tls: hubTls });
  const { lead, token: created } = ensureLead(h.db, opts.name, opts.teamName);
  // Re-creating a team on a machine that hosted one before: issue a fresh lead token for the existing team.
  const token = created ?? (opts.needToken ? rotateLeadToken(h.db) : null);
  try {
    server = await h.listen(opts.port, '0.0.0.0');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    hubError = err.code === 'EADDRINUSE'
      ? `Port ${opts.port} is already in use. Close the other program (or another Claude Link) using it.`
      : err.message;
    h.db.sql.close();
    throw new Error(hubError);
  }
  hub = h;
  advertise(opts.teamName, lead.name, opts.port);
  return { token, leadId: lead.id, cert: hubTls.cert, fingerprint: hubTls.fingerprint };
}

export async function stopHub() {
  stopAdvertising();
  if (!hub) return;
  await server?.close();
  hub.db.sql.close();
  hub = null;
  server = null;
}
