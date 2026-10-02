/**
 * Caddy's log lines (JSON, one per line) turned into entries, and the numbers of the Logs page: requests per minute
 * by status, most visited paths, who gets errors, and a plain explanation of a request that failed.
 */

export interface LogEntry {
  /** ms */
  ts: number;
  level: string;
  logger: string;
  msg: string;
  /** Present for access log entries. */
  req?: { host: string; method: string; uri: string; ip: string; status: number; ms: number; size: number; ua: string };
  /** The error text of error entries, and the identifier of tls ones. */
  error?: string;
  identifier?: string;
  raw: string;
  /** Where it came from: "journal", "container" or a log file path. */
  source: string;
}

interface CaddyJSON {
  level?: string;
  ts?: number | string;
  logger?: string;
  msg?: string;
  error?: string;
  identifier?: string;
  status?: number;
  duration?: number;
  size?: number;
  request?: { remote_ip?: string; client_ip?: string; method?: string; host?: string; uri?: string; headers?: Record<string, string[]> };
}

export function parseLine(line: string, source: string): LogEntry | null {
  const t = line.trim();
  if (!t) return null;
  const at = t.indexOf('{');
  if (at < 0) return { ts: Date.now(), level: 'info', logger: '', msg: t, raw: t, source };
  let o: CaddyJSON;
  try {
    o = JSON.parse(t.slice(at));
  } catch {
    return { ts: Date.now(), level: 'info', logger: '', msg: t, raw: t, source };
  }
  const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(o.ts ?? '') || Date.now();
  const e: LogEntry = { ts, level: o.level ?? 'info', logger: o.logger ?? '', msg: o.msg ?? '', raw: t.slice(at), source, error: o.error, identifier: o.identifier };
  if (o.logger?.startsWith('http.log.access') && o.request) {
    const r = o.request;
    e.req = {
      host: r.host ?? '',
      method: r.method ?? '',
      uri: r.uri ?? '',
      ip: r.client_ip || r.remote_ip || '',
      status: o.status ?? 0,
      ms: Math.round((o.duration ?? 0) * 1000),
      size: o.size ?? 0,
      ua: r.headers?.['User-Agent']?.[0] ?? '',
    };
  }
  return e;
}

export const isRequest = (e: LogEntry) => !!e.req;

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';
export const statusClass = (s: number): StatusClass => (s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : '2xx');

export interface Traffic {
  /** One bucket per minute, oldest first: [ok (2xx+3xx), 4xx, 5xx]. */
  buckets: [number, number, number][];
  total: number;
  errors: number;
  top: { key: string; n: number }[];
  offenders: { ip: string; n: number; why: string; status: number; path: string }[];
}

export function traffic(entries: LogEntry[], now = Date.now(), minutes = 60): Traffic {
  const buckets: [number, number, number][] = Array.from({ length: minutes }, () => [0, 0, 0]);
  const from = now - minutes * 60_000;
  const paths = new Map<string, number>();
  const ips = new Map<string, { n: number; paths: Map<string, number>; statuses: Map<number, number> }>();
  let total = 0;
  let errors = 0;
  for (const e of entries) {
    if (!e.req || e.ts < from || e.ts > now + 60_000) continue;
    total++;
    const i = Math.min(minutes - 1, Math.floor((e.ts - from) / 60_000));
    const s = e.req.status;
    buckets[i][s >= 500 ? 2 : s >= 400 ? 1 : 0]++;
    const path = e.req.uri.split('?')[0];
    if (s < 400) paths.set(e.req.host + path, (paths.get(e.req.host + path) ?? 0) + 1);
    else {
      errors++;
      const x = ips.get(e.req.ip) ?? { n: 0, paths: new Map(), statuses: new Map() };
      x.n++;
      x.paths.set(path, (x.paths.get(path) ?? 0) + 1);
      x.statuses.set(s, (x.statuses.get(s) ?? 0) + 1);
      ips.set(e.req.ip, x);
    }
  }
  const top = [...paths].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, n]) => ({ key, n }));
  const best = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])[0][0];
  const offenders = [...ips]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 3)
    .map(([ip, x]) => {
      const status = best(x.statuses);
      const path = best(x.paths);
      return { ip, n: x.n, status, path, why: status === 404 && x.paths.size > 2 ? 'probing' : 'status' };
    });
  return { buckets, total, errors, top, offenders };
}

/** Paths that bots look for on every server. */
const PROBES = /(\.env|wp-login|wp-admin|xmlrpc|phpmyadmin|\.git\/|\.aws|config\.php|admin\.php|cgi-bin|\.well-known\/security\.txt)/i;

export type Explanation =
  | { kind: 'unreachable'; upstream: string }
  | { kind: 'probe' }
  | { kind: 'auth' }
  | { kind: 'notfound' }
  | { kind: 'servererror' }
  | { kind: 'timeout'; upstream: string }
  | null;

/**
 * Why a request failed, using Caddy's error lines around it: a 502 next to "dial tcp X: connect: connection
 * refused" means nothing listens at X.
 */
export function explain(e: LogEntry, all: LogEntry[]): Explanation {
  const r = e.req;
  if (!r) return null;
  if (r.status === 502 || r.status === 504) {
    const near = all.find((x) => !x.req && x.logger.startsWith('http.log.error') && Math.abs(x.ts - e.ts) < 2000 && /dial|upstream|timeout/i.test(x.msg + (x.error ?? '')));
    const text = near ? `${near.msg} ${near.error ?? ''}` : '';
    const up = text.match(/dial tcp ([^:]+:\d+)|dial tcp: lookup ([^ :]+)/);
    const upstream = up ? up[1] ?? up[2] : '';
    if (/timeout|deadline/i.test(text) || r.status === 504) return { kind: 'timeout', upstream };
    return { kind: 'unreachable', upstream };
  }
  if (r.status === 404 && PROBES.test(r.uri)) return { kind: 'probe' };
  if (r.status === 401) return { kind: 'auth' };
  if (r.status === 404) return { kind: 'notfound' };
  if (r.status >= 500) return { kind: 'servererror' };
  return null;
}

/** TLS problems per domain, from Caddy's own log: the last failed attempts to get or renew a certificate. */
export function tlsFailures(entries: LogEntry[], since = Date.now() - 3 * 86400e3): Map<string, LogEntry[]> {
  const out = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (e.ts < since || e.level !== 'error' || !e.logger.startsWith('tls')) continue;
    const id = e.identifier ?? (e.raw.match(/"identifiers?":\s*\[?"([^"]+)"/)?.[1] ?? '');
    if (!id) continue;
    const l = out.get(id) ?? [];
    l.push(e);
    out.set(id, l);
  }
  for (const l of out.values()) l.sort((a, b) => b.ts - a.ts);
  return out;
}

/** The plain reason of an ACME failure. */
export type AcmeReason = 'dns' | 'unreachable' | 'ratelimit' | 'caa' | 'other';

export function acmeReason(text: string): AcmeReason {
  if (/NXDOMAIN|no valid A records|DNS problem|SERVFAIL|no such host/i.test(text)) return 'dns';
  if (/rateLimited|too many/i.test(text)) return 'ratelimit';
  if (/CAA/i.test(text)) return 'caa';
  if (/connection|timeout|Timeout during connect|refused|unreachable|Fetching http/i.test(text)) return 'unreachable';
  return 'other';
}
