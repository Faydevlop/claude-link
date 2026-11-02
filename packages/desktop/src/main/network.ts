import { Bonjour, type Service } from 'bonjour-service';
import { networkInterfaces } from 'node:os';
import type { DiscoveredTeam } from '../../../shared/src/desktop.ts';

const SERVICE_TYPE = 'claude-link';
let bonjour: Bonjour | null = null;
const instance = () => (bonjour ??= new Bonjour());

export const lanAddresses = () =>
  Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i!.address);

export function advertise(teamName: string, lead: string, port: number) {
  instance().unpublishAll();
  instance().publish({ name: `${teamName} (${lead})`, type: SERVICE_TYPE, port, txt: { team: teamName, lead } });
}

export function stopAdvertising() {
  bonjour?.unpublishAll();
}

/** Confirms a URL points at a Claude Link hub and returns its team info. */
export async function probeHub(url: string): Promise<DiscoveredTeam> {
  let base = url.trim();
  if (!/^https?:\/\//.test(base)) base = `http://${base}`;
  const u = new URL(base);
  if (!u.port) u.port = '4545';
  let res: Response;
  try { res = await fetch(new URL('/api/health', u), { signal: AbortSignal.timeout(3000) }); }
  catch { throw new Error(`No Claude Link team answered at ${u.host}. Check the address and that you're on the same Wi-Fi.`); }
  const h = await res.json().catch(() => ({})) as { name?: string; team?: string; lead?: string; version?: string };
  if (h.name !== 'claude-link') throw new Error(`${u.host} is not a Claude Link team.`);
  return { team: h.team ?? 'Claude Link team', lead: h.lead ?? null, url: u.origin, version: h.version ?? '?' };
}

/** Browses the local network for hubs for a few seconds. */
export async function discoverTeams(ms = 3000): Promise<DiscoveredTeam[]> {
  const found = new Map<string, Service>();
  const browser = instance().find({ type: SERVICE_TYPE }, svc => {
    const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ip) found.set(`${ip}:${svc.port}`, svc);
  });
  await new Promise(r => setTimeout(r, ms));
  browser.stop();
  const teams = await Promise.all([...found.keys()].map(hostPort => probeHub(`http://${hostPort}`).catch(() => null)));
  return teams.filter((t): t is DiscoveredTeam => !!t);
}
