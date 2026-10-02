/**
 * Does a domain point to this machine? The answer comes from public DNS (DNS over HTTPS at cloudflare-dns.com, the
 * only network host the plugin may reach) compared with the addresses of this machine (`ip -j addr`).
 */
import { run } from './run';

export type DnsState = 'here' | 'elsewhere' | 'missing' | 'unknown';

export interface DnsResult {
  state: DnsState;
  addresses: string[];
}

let local: Promise<{ all: string[]; hasPublic: boolean }> | undefined;

const isPrivate = (ip: string) =>
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || /^(::1|fe80:|fc|fd)/i.test(ip);

export function localAddresses(): Promise<{ all: string[]; hasPublic: boolean }> {
  if (!local) {
    local = run('addresses')
      .then((r) => {
        const ifs = JSON.parse(r.stdout || '[]') as { addr_info?: { local?: string }[] }[];
        const all = ifs.flatMap((i) => (i.addr_info ?? []).map((a) => a.local ?? '')).filter(Boolean);
        return { all, hasPublic: all.some((a) => !isPrivate(a)) };
      })
      .catch(() => ({ all: [], hasPublic: false }));
  }
  return local;
}

async function resolve(name: string, type: 'A' | 'AAAA'): Promise<string[] | null> {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) throw new Error(`DNS answered ${r.status}`);
  const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] };
  if (j.Status === 3) return null; // NXDOMAIN
  return (j.Answer ?? []).filter((a) => a.type === (type === 'A' ? 1 : 28)).map((a) => a.data);
}

const cache = new Map<string, Promise<DnsResult>>();

export function checkDns(name: string): Promise<DnsResult> {
  let p = cache.get(name);
  if (!p) {
    p = (async (): Promise<DnsResult> => {
      try {
        const [a, aaaa, me] = await Promise.all([resolve(name, 'A'), resolve(name, 'AAAA'), localAddresses()]);
        const addrs = [...(a ?? []), ...(aaaa ?? [])];
        if (!addrs.length) return { state: 'missing', addresses: [] };
        if (addrs.some((x) => me.all.includes(x))) return { state: 'here', addresses: addrs };
        // Behind NAT the machine does not know its public address: then we cannot tell.
        return { state: me.hasPublic ? 'elsewhere' : 'unknown', addresses: addrs };
      } catch {
        return { state: 'unknown', addresses: [] };
      }
    })();
    cache.set(name, p);
    setTimeout(() => cache.delete(name), 5 * 60_000);
  }
  return p;
}

/** This machine's addresses, for messages ("this server is 198.51.100.24"). */
export async function myPublicAddresses(): Promise<string[]> {
  return (await localAddresses()).all.filter((a) => !isPrivate(a));
}
