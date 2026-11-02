import { join } from 'node:path';
import { buildHub, ensureLead, rotateLeadToken } from '../../../hub/src/server.ts';
import { dataDir } from './settings.ts';
import { advertise, stopAdvertising } from './network.ts';

type Hub = ReturnType<typeof buildHub>;
let hub: Hub | null = null;
export let hubError: string | null = null;

export const hubRunning = () => !!hub;

/** Starts the team hub inside the app (lead only). Returns the lead token when the team was just created. */
export async function startHub(opts: { name: string; teamName: string; port: number; webDir: string; needToken: boolean }): Promise<{ token: string | null; leadId: number }> {
  if (hub) await stopHub();
  hubError = null;
  const h = buildHub({ dbPath: join(dataDir(), 'hub.db'), webDir: opts.webDir });
  const { lead, token: created } = ensureLead(h.db, opts.name, opts.teamName);
  // Re-creating a team on a machine that hosted one before: issue a fresh lead token for the existing team.
  const token = created ?? (opts.needToken ? rotateLeadToken(h.db) : null);
  try {
    await h.app.listen({ port: opts.port, host: '0.0.0.0' });
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
  return { token, leadId: lead.id };
}

export async function stopHub() {
  stopAdvertising();
  if (!hub) return;
  await hub.app.close();
  hub.db.sql.close();
  hub = null;
}
