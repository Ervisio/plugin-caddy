/**
 * Versions of the Caddyfile (and the files it imports): index.json lists them, <id>.json holds the files. At most
 * KEEP versions are kept.
 *
 * The system service keeps them in /var/lib/ervisio-caddy/history/system (written with administrator rights, which a
 * save needs anyway; readable by every user who sees the plugin). A Docker container keeps them in the home of the
 * user, ~/.config/ervisio/plugins/caddy/history/<container>, because members of the docker group manage it without
 * administrator rights.
 */
import { getSdk } from '../sdk';
import type { Instance } from './instances';
import { classify } from './run';

export const HISTORY_ROOT = '/var/lib/ervisio-caddy/history';
export const USER_HISTORY_ROOT = '~/.config/ervisio/plugins/caddy/history';

/** Where the versions of an instance live. */
export const historyKey = (inst: Pick<Instance, 'key' | 'kind'>) => `${inst.kind === 'docker' ? USER_HISTORY_ROOT : HISTORY_ROOT}/${inst.key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
const KEEP = 100;

export type VersionKind = 'first' | 'save' | 'external' | 'rollback' | 'restore';

export interface VersionMeta {
  id: string;
  ts: number;
  user: string;
  kind: VersionKind;
  /** What changed, e.g. "added:a.com|changed:b.com", or free text. */
  summary: string;
  ok: boolean;
}

export interface Version extends VersionMeta {
  files: Record<string, string>;
}

/** `key` is the folder from historyKey(). */
const dir = (key: string) => key;

export async function listVersions(key: string): Promise<VersionMeta[]> {
  try {
    const idx = JSON.parse(await getSdk().files.read(`${dir(key)}/index.json`)) as { versions: VersionMeta[] };
    return idx.versions.sort((a, b) => b.ts - a.ts);
  } catch (e) {
    const k = classify(e).kind;
    if (k === 'missing' || e instanceof SyntaxError) return [];
    throw e;
  }
}

export async function readVersion(key: string, id: string): Promise<Version> {
  return JSON.parse(await getSdk().files.read(`${dir(key)}/${id}.json`)) as Version;
}

export async function addVersion(key: string, v: Omit<Version, 'id' | 'ts'>): Promise<VersionMeta> {
  const fs = getSdk().files;
  const ts = Date.now();
  const id = `${ts}`;
  const meta: VersionMeta = { id, ts, user: v.user, kind: v.kind, summary: v.summary, ok: v.ok };
  await fs.mkdir(dir(key));
  await fs.write(`${dir(key)}/${id}.json`, JSON.stringify({ ...meta, files: v.files }));
  const all = [meta, ...(await listVersions(key))];
  const keep = all.slice(0, KEEP);
  for (const old of all.slice(KEEP)) await fs.remove(`${dir(key)}/${old.id}.json`).catch(() => {});
  await fs.write(`${dir(key)}/index.json`, JSON.stringify({ versions: keep }, null, 1));
  return meta;
}

/** Marks a version as failed (a reload that was rolled back). */
export async function markFailed(key: string, id: string): Promise<void> {
  const all = await listVersions(key);
  const v = all.find((x) => x.id === id);
  if (!v) return;
  v.ok = false;
  await getSdk().files.write(`${dir(key)}/index.json`, JSON.stringify({ versions: all }, null, 1));
}
