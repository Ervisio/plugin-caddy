/**
 * Changing Caddy safely. Every change goes through apply():
 *
 *   1. the files as they are now go to the history first (as "changed outside Ervisio" when they differ from the
 *      last version the plugin saved, or as the first version);
 *   2. the new files are written, checked with `caddy validate` and Caddy reloads;
 *   3. if the check or the reload fails, the old files are written back (and Caddy reloads them), and the attempt
 *      stays in the history marked as failed.
 */
import { summarize } from './caddyfile';
import { addVersion, historyKey, listVersions, markFailed, readVersion, type VersionKind } from './history';
import type { Instance } from './instances';
import { run } from './run';
import { forInstance, type Config } from './state';

export interface ApplyResult {
  ok: boolean;
  /** Where it failed. */
  stage?: 'write' | 'validate' | 'reload';
  output: string;
  /** The files before the change (for Undo). */
  before: Record<string, string>;
  /** Caddy was stopped: the change waits for the next start. */
  notRunning?: boolean;
}

const hk = (inst: Instance) => historyKey(inst);

let whoami: Promise<string> | undefined;
const user = () =>
  (whoami ??= run('user')
    .then((r) => r.stdout.trim() || '?')
    .catch(() => '?'));

/** A summary string for the history: "added:a.com,b.com|changed:c.com". */
export function summaryOf(before: Record<string, string>, after: Record<string, string>): string {
  const parts: string[] = [];
  const acc = { added: [] as string[], removed: [] as string[], changed: [] as string[], off: [] as string[], on: [] as string[] };
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const s = summarize(before[p] ?? '', after[p] ?? '');
    for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k].push(...s[k]);
  }
  for (const [k, v] of Object.entries(acc)) if (v.length) parts.push(`${k}:${v.join(',')}`);
  return parts.join('|') || 'edited';
}

async function rememberCurrent(inst: Instance, current: Record<string, string>): Promise<void> {
  const versions = await listVersions(hk(inst));
  const who = await user();
  if (!versions.length) {
    await addVersion(hk(inst), { user: who, kind: 'first', summary: 'first', ok: true, files: current });
    return;
  }
  const lastOk = versions.find((v) => v.ok);
  if (!lastOk) return;
  const last = await readVersion(hk(inst), lastOk.id).catch(() => null);
  if (!last) return;
  const differs = Object.keys(current).some((p) => (last.files[p] ?? '') !== current[p]);
  if (differs) await addVersion(hk(inst), { user: '', kind: 'external', summary: summaryOf(last.files, current), ok: true, files: current });
}

export async function apply(inst: Instance, cfg: Config, next: Record<string, string>, kind: VersionKind = 'save'): Promise<ApplyResult> {
  const { backend, config } = forInstance(inst);
  // Re-read what is on disk now: someone may have changed it since the page loaded.
  const before: Record<string, string> = {};
  for (const p of Object.keys({ ...cfg.files, ...next })) {
    try {
      before[p] = await backend.readFile(p);
    } catch {
      before[p] = '';
    }
  }
  const after = { ...before, ...next };
  const changed = Object.keys(next).filter((p) => before[p] !== next[p]);
  if (!changed.length) return { ok: true, output: '', before };

  await rememberCurrent(inst, before).catch(() => {});

  const restore = async () => {
    for (const p of changed) await backend.writeFile(p, before[p]).catch(() => {});
  };
  try {
    for (const p of changed) await backend.writeFile(p, next[p]);
  } catch (e) {
    await restore();
    return { ok: false, stage: 'write', output: (e as Error).message, before };
  }
  const who = await user();
  const summary = summaryOf(before, after);
  const v = await backend.validate();
  if (!v.ok) {
    await restore();
    await addVersion(hk(inst), { user: who, kind, summary, ok: false, files: after }).catch(() => {});
    void config.refresh();
    return { ok: false, stage: 'validate', output: cleanOutput(v.output), before };
  }
  if (!inst.running) {
    const meta = await addVersion(hk(inst), { user: who, kind, summary, ok: true, files: after }).catch(() => null);
    void meta;
    void config.refresh();
    return { ok: true, output: '', before, notRunning: true };
  }
  const r = await backend.reload();
  if (!r.ok) {
    await restore();
    await backend.reload().catch(() => {});
    const meta = await addVersion(hk(inst), { user: who, kind, summary, ok: false, files: after }).catch(() => null);
    if (meta) await markFailed(hk(inst), meta.id).catch(() => {});
    void config.refresh();
    return { ok: false, stage: 'reload', output: cleanOutput(r.output), before };
  }
  await addVersion(hk(inst), { user: who, kind, summary, ok: true, files: after }).catch(() => {});
  void config.refresh();
  return { ok: true, output: '', before };
}

/** Keeps the useful part of caddy's output: the "Error: ..." line, without the JSON log noise. */
export function cleanOutput(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^Error:|error/i.test(l) && !l.startsWith('{'));
  const pick = (err.length ? err : lines).slice(-3);
  return pick
    .map((l) => {
      if (!l.startsWith('{')) return l;
      try {
        const o = JSON.parse(l) as { msg?: string; error?: string };
        return [o.msg, o.error].filter(Boolean).join(': ');
      } catch {
        return l;
      }
    })
    .join('\n')
    .replace(/\s*import chain:?\s*\[[^\]]*\]/g, '')
    .slice(0, 800);
}

/** Line number (1-based) and file of a caddy validate/adapt error, when it says "Caddyfile:12". */
export function errorLocation(output: string): { file: string; line: number } | null {
  const m = output.match(/([^\s,:]+):(\d+)(?:\s|:|,|$)/);
  if (!m) return null;
  return { file: m[1], line: +m[2] };
}

export async function reloadOnly(inst: Instance): Promise<{ ok: boolean; output: string }> {
  const { backend } = forInstance(inst);
  const r = await backend.reload();
  return { ok: r.ok, output: cleanOutput(r.output) };
}
