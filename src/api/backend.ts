/**
 * One interface for both kinds of Caddy. Views never care whether Caddy runs as a system service or in a container:
 *
 *   const b = backendFor(instance);
 *   const text = await b.readFile(instance.configPath);
 *   await b.writeFile(path, text); const v = await b.validate(); const r = await b.reload();
 *
 * Paths are always the ones Caddy itself uses (inside the container for Docker).
 */
import { getSdk } from '../sdk';
import { containerAction, containerLogs, execIn, followContainer } from './docker';
import type { Instance } from './instances';
import { CommandError, classify, follow, run } from './run';
import { parsePEM } from './x509';

export interface Outcome {
  ok: boolean;
  output: string;
}

export interface CertFile {
  /** Folder of the issuer in Caddy's storage, e.g. "acme-v02.api.letsencrypt.org-directory" or "local". */
  issuerDir: string;
  path: string;
  pem: string;
}

/** The certificate a site presents (from a TLS connection or from Caddy's storage). */
export interface Presented {
  notBefore: number;
  notAfter: number;
  issuer: string;
  local: boolean;
}

/** Reads `curl -v` output: "start date: ...", "expire date: ...", "issuer: ...". */
export function parseCurlCert(err: string): Presented | null {
  const get = (k: string) => err.match(new RegExp(`^\\*\\s+${k}:\\s*(.+)$`, 'm'))?.[1].trim() ?? '';
  const nb = Date.parse(get('start date'));
  const na = Date.parse(get('expire date'));
  if (!na) return null;
  const issuer = get('issuer');
  const o = issuer.match(/O=([^;]+)/)?.[1]?.trim() ?? issuer.match(/CN=([^;]+)/)?.[1]?.trim() ?? issuer;
  return { notBefore: nb || na - 90 * 86400e3, notAfter: na, issuer: o, local: /Caddy Local Authority/i.test(issuer) };
}

export interface Backend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** Every file in the Caddyfile's folder and one level below, for imports. */
  configFiles(): Promise<string[]>;
  /** caddy validate on the Caddyfile, or on `path` (a candidate written next to it). */
  validate(path?: string): Promise<Outcome>;
  reload(): Promise<Outcome>;
  service(action: 'start' | 'stop' | 'restart'): Promise<void>;
  /** Caddy's own output (JSON lines): the journal of caddy.service or the container's output. */
  logLines(n: number): Promise<string[]>;
  followLogs(onLine: (l: string) => void, onEnd?: (e?: Error) => void): { close(): void };
  /** The end of a log file Caddy writes (an access log). */
  tailFile(path: string, n: number): Promise<string[]>;
  followFile(path: string, onLine: (l: string) => void, onEnd?: (e?: Error) => void): { close(): void };
  certificates(): Promise<CertFile[]>;
  rootCA(): Promise<string | null>;
  /** For each URL: true = something answers, false = nothing answers, null = cannot tell. */
  probe(urls: string[]): Promise<Record<string, boolean | null>>;
  /** The certificate each name presents, without administrator rights where possible. */
  presented(names: string[]): Promise<Record<string, Presented | null>>;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const lines = (s: string) => s.split('\n').filter((l) => l.trim() !== '');

/* ---------- system service ---------- */

const STORAGE = '/var/lib/caddy/.local/share/caddy';

class SystemBackend implements Backend {
  private journalAdmin = false;
  constructor(private inst: Instance) {}

  readFile(path: string) {
    return getSdk().files.read(path);
  }
  writeFile(path: string, text: string) {
    return getSdk().files.write(path, text);
  }
  removeFile(path: string) {
    return getSdk().files.remove(path);
  }

  async configFiles(): Promise<string[]> {
    const root = dirOf(this.inst.configPath);
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      const entries = await getSdk().files.list(dir);
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = `${dir}/${e.name}`;
        if (e.type === 'file') out.push(p);
        else if (e.type === 'dir' && depth < 1) await walk(p, depth + 1);
      }
    };
    await walk(root, 0);
    return out.sort();
  }

  async validate(path = this.inst.configPath): Promise<Outcome> {
    const r = await run('validate', [path]);
    return { ok: r.exitCode === 0, output: (r.stderr + r.stdout).trim() };
  }

  async reload(): Promise<Outcome> {
    const r = await run('service', ['reload']);
    if (r.exitCode === 0) return { ok: true, output: '' };
    // systemctl only says that the job failed: the reason is in Caddy's own log.
    const tail = await this.logLines(30).catch(() => [] as string[]);
    const err = tail.map(parseMsg).filter((m) => m && /error|fail|adapt|load/i.test(m)).pop();
    return { ok: false, output: err || (r.stderr || r.stdout).trim() };
  }

  async service(action: 'start' | 'stop' | 'restart') {
    const r = await run('service', [action]);
    if (r.exitCode !== 0) throw new CommandError('systemctl', r);
  }

  async logLines(n: number): Promise<string[]> {
    if (!this.journalAdmin) {
      const r = await run('journal', [String(n)]);
      const out = lines(r.stdout);
      // A user outside systemd-journal/adm/wheel sees nothing (journalctl only prints a hint): ask again as admin.
      if (out.length || !/not seeing messages|no journal files|insufficient permissions|permission/i.test(r.stderr)) return out;
      this.journalAdmin = true;
    }
    return lines((await run('journal-admin', [String(n)])).stdout);
  }

  followLogs(onLine: (l: string) => void, onEnd?: (e?: Error) => void) {
    return follow(this.journalAdmin ? 'journal-follow-admin' : 'journal-follow', [], onLine, onEnd);
  }

  async tailFile(path: string, n: number) {
    const r = await run('tail', [String(n), path]);
    if (r.exitCode !== 0) throw new CommandError('tail', r);
    return lines(r.stdout);
  }

  followFile(path: string, onLine: (l: string) => void, onEnd?: (e?: Error) => void) {
    return follow('tail-follow', [path], onLine, onEnd);
  }

  async certificates(): Promise<CertFile[]> {
    const fs = getSdk().files;
    const base = `${STORAGE}/certificates`;
    const out: CertFile[] = [];
    let issuers;
    try {
      issuers = await fs.list(base);
    } catch (e) {
      if (classify(e).kind === 'missing') return [];
      throw e;
    }
    for (const iss of issuers.filter((x) => x.type === 'dir')) {
      for (const site of (await fs.list(`${base}/${iss.name}`)).filter((x) => x.type === 'dir')) {
        const path = `${base}/${iss.name}/${site.name}/${site.name}.crt`;
        try {
          out.push({ issuerDir: iss.name, path, pem: await fs.read(path) });
        } catch {
          /* a folder without its certificate (being obtained) */
        }
      }
    }
    return out;
  }

  async rootCA() {
    try {
      return await getSdk().files.read(`${STORAGE}/pki/authorities/local/root.crt`);
    } catch {
      return null;
    }
  }

  async presented(names: string[]) {
    const res: Record<string, Presented | null> = {};
    await Promise.all(
      names.map(async (n) => {
        try {
          res[n] = parseCurlCert((await run('tls-check', [n])).stderr);
        } catch {
          res[n] = null;
        }
      }),
    );
    return res;
  }

  async probe(urls: string[]) {
    const res: Record<string, boolean | null> = {};
    await Promise.all(
      urls.map(async (u) => {
        try {
          const r = await run('probe', [u]);
          const code = r.stdout.trim();
          res[u] = /^\d{3}$/.test(code) ? code !== '000' : null;
        } catch {
          res[u] = null;
        }
      }),
    );
    return res;
  }
}

/* ---------- Docker container ---------- */

const PROBE_SCRIPT = `for u in "$@"; do
  if out=$(wget -q -T 3 -O /dev/null "$u" 2>&1); then echo "up $u"
  else case "$out" in *"returned error"*|*"HTTP/"*) echo "up $u";; *) echo "down $u";; esac; fi
done`;

const CERTS_SCRIPT = `d="$1/certificates"; [ -d "$d" ] || exit 0
find "$d" -name '*.crt' | while read -r f; do echo "### $f"; cat "$f"; done`;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

class DockerBackend implements Backend {
  private id: string;
  constructor(private inst: Instance) {
    this.id = inst.container!.id;
  }

  private async sh(script: string, args: string[] = [], env?: string[]) {
    return execIn(this.id, ['sh', '-c', script, 'sh', ...args], env);
  }

  async readFile(path: string) {
    const r = await execIn(this.id, ['cat', path]);
    if (r.exitCode !== 0) throw Object.assign(new Error(r.stderr.trim() || `Cannot read ${path}`), { code: /No such file/.test(r.stderr) ? 'not_found' : 'failed' });
    return r.stdout;
  }

  /** Written in pieces (a command argument is at most 128 KiB), then copied over the file with `cat >` so a
   *  Caddyfile mounted as a single file keeps its inode (a rename would fail on a bind mount). */
  async writeFile(path: string, text: string) {
    const b64 = toBase64(new TextEncoder().encode(text));
    const tmp = `${path}.ervisio-tmp`;
    const step = 96 * 1024;
    for (let i = 0; i === 0 || i < b64.length; i += step) {
      const r = await this.sh(`printf %s "$1" | base64 -d ${i === 0 ? '>' : '>>'} "$2"`, [b64.slice(i, i + step), tmp]);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Cannot write ${path}`);
    }
    const r = await this.sh('mkdir -p "$(dirname "$2")" && cat "$1" > "$2" && rm -f "$1"', [tmp, path]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Cannot write ${path}`);
  }

  async removeFile(path: string) {
    await execIn(this.id, ['rm', '-f', path]);
  }

  async configFiles() {
    const r = await execIn(this.id, ['find', dirOf(this.inst.configPath), '-maxdepth', '2', '-type', 'f', '!', '-name', '.*', '!', '-name', '*.ervisio-tmp']);
    return lines(r.stdout).sort();
  }

  async validate(path = this.inst.configPath): Promise<Outcome> {
    const r = await execIn(this.id, ['caddy', 'validate', '--config', path, '--adapter', 'caddyfile'], [
      'XDG_DATA_HOME=/tmp/ervisio-caddy/data',
      'XDG_CONFIG_HOME=/tmp/ervisio-caddy/config',
    ]);
    return { ok: r.exitCode === 0, output: (r.stderr + r.stdout).trim() };
  }

  async reload(): Promise<Outcome> {
    const r = await execIn(this.id, ['caddy', 'reload', '--config', this.inst.configPath, '--adapter', 'caddyfile', '--force']);
    return { ok: r.exitCode === 0, output: (r.stderr + r.stdout).trim() };
  }

  service(action: 'start' | 'stop' | 'restart') {
    return containerAction(this.id, action);
  }

  logLines(n: number) {
    return containerLogs(this.id, n);
  }

  followLogs(onLine: (l: string) => void, onEnd?: (e?: Error) => void) {
    return followContainer(this.id, onLine, onEnd);
  }

  async tailFile(path: string, n: number) {
    const r = await execIn(this.id, ['tail', '-n', String(n), path]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Cannot read ${path}`);
    return lines(r.stdout);
  }

  /** No live stream into a container file: poll the end of it. */
  followFile(path: string, onLine: (l: string) => void, onEnd?: (e?: Error) => void) {
    let last = '';
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const got = await this.tailFile(path, 200);
        const at = last ? got.lastIndexOf(last) : got.length - 1;
        got.slice(at + 1).forEach(onLine);
        if (got.length) last = got[got.length - 1];
      } catch (e) {
        stopped = true;
        onEnd?.(e as Error);
        return;
      }
      setTimeout(tick, 4000);
    };
    void this.tailFile(path, 1)
      .then((g) => {
        last = g[0] ?? '';
        setTimeout(tick, 4000);
      })
      .catch((e) => onEnd?.(e));
    return { close: () => (stopped = true) };
  }

  async certificates(): Promise<CertFile[]> {
    const r = await this.sh(CERTS_SCRIPT, [this.inst.dataDir!]);
    const out: CertFile[] = [];
    for (const part of r.stdout.split(/^### /m).slice(1)) {
      const nl = part.indexOf('\n');
      const path = part.slice(0, nl).trim();
      const rel = path.slice(`${this.inst.dataDir}/certificates/`.length).split('/');
      out.push({ issuerDir: rel[0], path, pem: part.slice(nl + 1) });
    }
    return out;
  }

  async rootCA() {
    try {
      return await this.readFile(`${this.inst.dataDir}/pki/authorities/local/root.crt`);
    } catch {
      return null;
    }
  }

  async presented(names: string[]) {
    const res: Record<string, Presented | null> = Object.fromEntries(names.map((n) => [n, null]));
    for (const f of await this.certificates().catch(() => [])) {
      const c = await parsePEM(f.pem).catch(() => null);
      if (!c) continue;
      const p: Presented = { notBefore: c.notBefore, notAfter: c.notAfter, issuer: c.issuerO || c.issuerCN, local: f.issuerDir === 'local' };
      for (const n of c.names) if (n in res && (!res[n] || res[n]!.notAfter < p.notAfter)) res[n] = p;
    }
    return res;
  }

  async probe(urls: string[]) {
    const res: Record<string, boolean | null> = Object.fromEntries(urls.map((u) => [u, null]));
    if (!urls.length) return res;
    try {
      const r = await this.sh(PROBE_SCRIPT, urls);
      for (const l of lines(r.stdout)) {
        const [state, u] = l.split(' ');
        if (u in res) res[u] = state === 'up';
      }
    } catch {
      /* no shell or no wget in this image */
    }
    return res;
  }
}

const cache = new Map<string, Backend>();

export function backendFor(inst: Instance): Backend {
  const k = `${inst.key}:${inst.container?.id ?? ''}`;
  let b = cache.get(k);
  if (!b) {
    b = inst.kind === 'docker' ? new DockerBackend(inst) : new SystemBackend(inst);
    cache.set(k, b);
  }
  return b;
}

/** The "msg" of a Caddy JSON log line (or the line itself). */
export function parseMsg(line: string): string {
  try {
    const o = JSON.parse(line) as { msg?: string; error?: string };
    return [o.msg, o.error].filter(Boolean).join(': ');
  } catch {
    return line;
  }
}
