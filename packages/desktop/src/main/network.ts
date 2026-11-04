import { Bonjour, type Service } from 'bonjour-service';
import { networkInterfaces } from 'node:os';
import type { DiscoveredTeam } from '../../../shared/src/desktop.ts';
import { probeHubAddress, type HubInfo } from '../../../cli/src/net.ts';

const SERVICE_TYPE = 'claude-link';
let bonjour: Bonjour | null = null;
const instance = () => (bonjour ??= new Bonjour());

export const lanAddresses = () =>
  Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i!.address);

export function advertise(teamName: string, lead: string, port: number) {
  instance().unpublishAll();
  // Discovery is a convenience only: it advertises a name and port, never anything secret.
  instance().publish({ name: `${teamName} (${lead})`.slice(0, 60), type: SERVICE_TYPE, port, txt: { team: teamName.slice(0, 80), lead: lead.slice(0, 60) } });
}

export function stopAdvertising() {
  bonjour?.unpublishAll();
}

/** Hub details as seen from this computer, including the certificate it presented. Kept for the join that follows. */
const seen = new Map<string, HubInfo>();
export const seenHub = (url: string) => seen.get(url) ?? null;

const toTeam = (h: HubInfo): DiscoveredTeam => ({ team: h.team, lead: h.lead, url: h.url, version: h.version, encrypted: h.tls, fingerprint: h.fingerprint });

/** Confirms an address points at a Claude Link hub and returns its team info. */
export async function probeHub(url: string): Promise<DiscoveredTeam> {
  if (typeof url !== 'string' || url.length > 300) throw new Error('Invalid address.');
  const h = await probeHubAddress(url, 3000);
  seen.set(h.url, h);
  return toTeam(h);
}

/** Browses the local network for hubs for a few seconds. */
export async function discoverTeams(ms = 3000): Promise<DiscoveredTeam[]> {
  const found = new Map<string, Service>();
  const browser = instance().find({ type: SERVICE_TYPE }, svc => {
    const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ip && Number.isInteger(svc.port) && svc.port > 0 && svc.port < 65536) found.set(`${ip}:${svc.port}`, svc);
  });
  await new Promise(r => setTimeout(r, ms));
  browser.stop();
  const teams = await Promise.all([...found.keys()].slice(0, 20).map(hostPort => probeHub(hostPort).catch(() => null)));
  return teams.filter((t): t is DiscoveredTeam => !!t);
}
