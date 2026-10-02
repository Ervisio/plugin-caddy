/**
 * What the page knows: the Caddy servers found, the one chosen, and per server its config files, sites, backend
 * checks, certificates and log entries. Views read these with `.use()` and call the actions in actions.ts.
 */
import { useSyncExternalStore } from 'react';
import { backendFor, type Backend, type Presented } from './backend';
import { importedFiles, parse, publicNames, upstreamURL, type Doc, type Site } from './caddyfile';
import { detectAll, type Detection, type Instance } from './instances';
import { parseLine, type LogEntry } from './logs';
import { loadPrefs, savePrefs } from './prefs';
import { classify } from './run';
import { resource, store, type Resource } from './store';
import { parsePEM, type CertInfo } from './x509';

/* ---------- servers ---------- */

export const detection = resource<Detection>(async () => {
  const p = await loadPrefs();
  return detectAll(!!p.askDocker || !!p.instance?.startsWith('docker-'));
});

const chosen = store<string | null>(null);

/** The server shown: the one chosen, else the remembered one, else the first running one. */
export function currentInstance(): Instance | undefined {
  const list = detection.get().data?.instances ?? [];
  const key = chosen.get();
  return list.find((i) => i.key === key) ?? list.find((i) => i.running) ?? list[0];
}

export function useInstance(): Instance | undefined {
  detection.use();
  chosen.use();
  return currentInstance();
}

export async function initSelection(): Promise<void> {
  const p = await loadPrefs();
  if (p.instance && !chosen.get()) chosen.set(p.instance);
  await detection.refresh();
}

export function chooseInstance(key: string): void {
  chosen.set(key);
  void savePrefs({ instance: key });
}

/** Look in Docker even if that needs administrator rights, and remember it. */
export async function lookInDocker(): Promise<void> {
  await savePrefs({ askDocker: true });
  await detection.refresh();
}

/* ---------- per server data ---------- */

export interface SiteRef extends Site {
  file: string;
}

export interface Config {
  main: string;
  /** main first, then the files it imports. */
  order: string[];
  files: Record<string, string>;
  docs: Record<string, Doc>;
  sites: SiteRef[];
  /** Every file in the config folder (for the editor's file tabs). */
  all: string[];
}

export interface CertView extends CertInfo {
  path: string;
  issuer: string;
  issuerKind: 'letsencrypt' | 'zerossl' | 'local' | 'other';
}

interface PerInstance {
  backend: Backend;
  config: Resource<Config>;
  certs: Resource<CertView[]>;
  logs: Resource<LogEntry[]>;
  probes: Resource<Record<string, boolean | null>>;
  /** The certificate each site name presents (Sites tab; no administrator rights on the system service). */
  presented: Resource<Record<string, Presented | null>>;
}

const per = new Map<string, PerInstance>();

export function configOf(files: Record<string, string>, main: string, all: string[]): Config {
  const docs: Record<string, Doc> = {};
  for (const [p, t] of Object.entries(files)) docs[p] = parse(t);
  const order = [main, ...Object.keys(files).filter((p) => p !== main).sort()];
  const sites = order.flatMap((f) => docs[f].sites.map((s) => ({ ...s, file: f })));
  return { main, order, files, docs, sites, all };
}

async function loadConfig(inst: Instance, b: Backend): Promise<Config> {
  const main = inst.configPath;
  let text = '';
  try {
    text = await b.readFile(main);
  } catch (e) {
    if (classify(e).kind !== 'missing' && !/No such file/i.test(String((e as Error).message))) throw e;
  }
  const all = await b.configFiles().catch(() => [main]);
  const files: Record<string, string> = { [main]: text };
  for (const f of importedFiles(parse(text), main, all)) {
    try {
      files[f] = await b.readFile(f);
    } catch {
      /* unreadable import: shown by caddy validate */
    }
  }
  return configOf(files, main, all.includes(main) ? all : [main, ...all]);
}

function issuerOf(dir: string, c: CertInfo): Pick<CertView, 'issuer' | 'issuerKind'> {
  if (/letsencrypt/i.test(dir) || /let's encrypt/i.test(c.issuerO)) return { issuer: "Let's Encrypt", issuerKind: 'letsencrypt' };
  if (/zerossl/i.test(dir) || /zerossl/i.test(c.issuerO)) return { issuer: 'ZeroSSL', issuerKind: 'zerossl' };
  if (dir === 'local' || /caddy local/i.test(c.issuerCN + c.issuerO)) return { issuer: 'Caddy local CA', issuerKind: 'local' };
  return { issuer: c.issuerO || c.issuerCN || dir, issuerKind: 'other' };
}

async function loadCerts(b: Backend): Promise<CertView[]> {
  const files = await b.certificates();
  const byName = new Map<string, CertView>();
  for (const f of files) {
    const c = await parsePEM(f.pem).catch(() => null);
    if (!c) continue;
    const v: CertView = { ...c, path: f.path, ...issuerOf(f.issuerDir, c) };
    const k = v.names.join(',');
    const old = byName.get(k);
    if (!old || old.notAfter < v.notAfter) byName.set(k, v);
  }
  return [...byName.values()].sort((a, b) => a.notAfter - b.notAfter);
}

async function loadLogs(inst: Instance, b: Backend, cfg: Config | undefined): Promise<LogEntry[]> {
  const src = inst.kind === 'docker' ? 'container' : 'journal';
  const out: LogEntry[] = [];
  const own = await b.logLines(4000);
  for (const l of own) {
    const e = parseLine(l, src);
    if (e) out.push(e);
  }
  for (const f of logFiles(inst, cfg)) {
    try {
      for (const l of await b.tailFile(f, 3000)) {
        const e = parseLine(l, f);
        if (e) out.push(e);
      }
    } catch {
      /* not written yet */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Access log files the sites write (only /var/log/caddy on the system: the plugin may read nothing else). */
export function logFiles(inst: Instance, cfg: Config | undefined): string[] {
  const set = new Set<string>();
  for (const s of cfg?.sites ?? []) if (s.options.logFile && !s.disabled) set.add(s.options.logFile);
  return [...set].filter((f) => inst.kind === 'docker' || /^\/var\/log\/caddy\/[A-Za-z0-9._-]+$/.test(f));
}

export function probeTargets(cfg: Config | undefined): string[] {
  const set = new Set<string>();
  for (const s of cfg?.sites ?? []) {
    if (s.disabled || s.kind !== 'proxy') continue;
    const u = upstreamURL(s.target);
    if (u) set.add(u);
  }
  return [...set];
}

/** Names of enabled sites that use HTTPS (not :80, not http://). */
export function siteNames(cfg: Config | undefined): string[] {
  const set = new Set<string>();
  for (const s of cfg?.sites ?? []) {
    if (s.disabled) continue;
    for (const a of s.addresses) {
      if (a.startsWith('http://') || /:80$/.test(a) || a.startsWith(':')) continue;
      const h = a.replace(/^https:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '');
      if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(h)) set.add(h);
    }
  }
  return [...set];
}

export function forInstance(inst: Instance): PerInstance {
  const k = `${inst.key}:${inst.container?.id ?? ''}`;
  let p = per.get(k);
  if (!p) {
    const backend = backendFor(inst);
    const config = resource(() => loadConfig(inst, backend));
    const probes = resource(async () => backend.probe(probeTargets(config.get().data)));
    p = {
      backend,
      config,
      certs: resource(() => loadCerts(backend)),
      logs: resource(() => loadLogs(inst, backend, config.get().data)),
      probes,
      presented: resource(async () => backend.presented(siteNames(config.get().data))),
    };
    per.set(k, p);
    config.subscribe(() => {
      if (config.get().data && !config.get().loading) {
        void probes.refresh();
        void p!.presented.refresh();
      }
    });
  }
  return p;
}

/** Hook: the data of the current server. */
export function useCurrent(): { inst: Instance; data: PerInstance } | undefined {
  const inst = useInstance();
  return inst ? { inst, data: forInstance(inst) } : undefined;
}

/** Live clock for "up 3 days" and relative times (ticks every 30 s). */
const clock = store(Date.now());
setInterval(() => clock.set(Date.now()), 30_000);
export const useNow = (): number => useSyncExternalStore(clock.subscribe, clock.get);

export { publicNames };
