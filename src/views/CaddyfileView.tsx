import { useEffect, useMemo, useState } from 'react';
import { apply, cleanOutput, errorLocation } from '../api/actions';
import { format, lineMarks, parse, publicNames, upstreamURL } from '../api/caddyfile';
import { checkDns, myPublicAddresses, type DnsResult } from '../api/dns';
import { historyKey, listVersions, readVersion, type Version, type VersionMeta } from '../api/history';
import { errorText } from '../api/run';
import { useCurrent, useNow, type Config } from '../api/state';
import { resource, store } from '../api/store';
import { t, tn } from '../i18n';
import { Button, Icon, IconButton, Skeleton, toast } from '../kit';
import { nav } from '../shell/nav';
import { CodeEditor, type LineMark } from '../ui/CodeEditor';
import { ErrorBox } from '../ui/ErrorBox';
import { relative } from '../ui/format';
import { KIND_ICON } from '../ui/icons';

/** Unsaved edits per server and file; they survive switching tabs. */
const drafts = store<Record<string, Record<string, string>>>({});
const versionsRes = new Map<string, ReturnType<typeof resource<VersionMeta[]>>>();
const versionsOf = (key: string) => {
  let r = versionsRes.get(key);
  if (!r) versionsRes.set(key, (r = resource(() => listVersions(key))));
  return r;
};

interface Check {
  at: number;
  ok: boolean;
  output: string;
  file: string;
  line: number | null;
}

const name = (p: string) => p.split('/').pop()!;

/** Caddyfile (design 037 a): versions, editor, blocks and checks. */
export function CaddyfileView() {
  const { inst, data } = useCurrent()!;
  const cfg = data.config.use();
  const n = nav.use();
  const all = drafts.use();
  const now = useNow();
  const versions = versionsOf(historyKey(inst));
  const vs = versions.use();
  const [file, setFile] = useState<string>(inst.configPath);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Version | null>(null);

  useEffect(() => {
    void data.config.ensure();
    void versions.ensure(30_000);
  }, [data]);

  useEffect(() => {
    if (!n.jump) return;
    setViewing(null);
    setFile(n.jump.file);
    setJump({ line: n.jump.line, n: n.jump.n });
  }, [n.jump?.n]);

  if (cfg.error && !cfg.data) return <ErrorBox error={cfg.error} onRetry={() => void data.config.refresh()} />;
  if (!cfg.data) return <Skeleton lines={10} />;
  const c: Config = cfg.data;
  const cur = c.files[file] !== undefined ? file : c.main;
  const mine = all[inst.key] ?? {};
  const saved = c.files[cur] ?? '';
  const text = viewing ? viewing.files[cur] ?? '' : mine[cur] ?? saved;
  const dirty = Object.entries(mine).filter(([p, v]) => c.files[p] !== undefined && v !== c.files[p]);
  const setText = (v: string) => drafts.set((d) => ({ ...d, [inst.key]: { ...(d[inst.key] ?? {}), [cur]: v } }));
  const discard = () => drafts.set((d) => ({ ...d, [inst.key]: {} }));

  const marks: LineMark[] = lineMarks(saved, text);
  if (check && !check.ok && check.line && name(check.file) === name(cur) && !viewing) marks[check.line - 1] = 'err';
  const changedLines = marks.filter((x) => x === 'add' || x === 'chg').length + Math.max(0, saved.split('\n').length - text.split('\n').length);

  const runCheck = async () => {
    setBusy('check');
    try {
      const b = data.backend;
      const dir = c.main.slice(0, c.main.lastIndexOf('/'));
      const cand = `${dir}/.ervisio-check.caddy`;
      const mainText = mine[c.main] ?? c.files[c.main];
      await b.writeFile(cand, mainText);
      const v = await b.validate(cand);
      await b.removeFile(cand).catch(() => {});
      const out = cleanOutput(v.output.replaceAll(cand, c.main));
      const loc = errorLocation(out);
      setCheck({ at: Date.now(), ok: v.ok, output: out, file: loc?.file ?? c.main, line: loc?.line ?? null });
      if (!v.ok && loc) {
        setFile(c.order.find((p) => name(p) === name(loc.file)) ?? c.main);
        setJump({ line: loc.line, n: Date.now() });
      }
    } catch (e) {
      toast.err(t('cf.checkFailed'), errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (files: Record<string, string>, kind: 'save' | 'restore' = 'save') => {
    setBusy(kind);
    try {
      const r = await apply(inst, c, files, kind);
      if (r.ok) {
        discard();
        setViewing(null);
        setCheck({ at: Date.now(), ok: true, output: '', file: c.main, line: null });
        toast.ok(kind === 'restore' ? t('cf.restored') : t('cf.saved'), r.notRunning ? t('editor.notRunning') : t('shell.reloadedText'));
      } else {
        const loc = errorLocation(r.output);
        setCheck({ at: Date.now(), ok: false, output: r.output, file: loc?.file ?? c.main, line: loc?.line ?? null });
        toast.err(t(`cf.fail.${r.stage}`), r.output);
        if (loc) setJump({ line: loc.line, n: Date.now() });
      }
    } catch (e) {
      toast.err(t('cf.saveFailed'), errorText(e));
    } finally {
      setBusy(null);
      void versions.refresh();
    }
  };

  const open = async (v: VersionMeta) => {
    try {
      setViewing(await readVersion(historyKey(inst), v.id));
    } catch (e) {
      toast.err(t('cf.versionFailed'), errorText(e));
    }
  };

  return (
    <div className="cd-cf">
      <aside className="cd-hs" aria-label={t('cf.versions')}>
        <h3><Icon name="history" size={16} />{t('cf.versions')}</h3>
        {dirty.length > 0 && (
          <button type="button" className={`cd-hv is-warn${viewing ? '' : ' is-on'}`} onClick={() => setViewing(null)}>
            <span className="cd-hv-dot" />
            <span><b>{t('cf.nowEdit')}</b><small>{t('cf.notSaved')}</small></span>
          </button>
        )}
        {!dirty.length && viewing && (
          <button type="button" className="cd-hv" onClick={() => setViewing(null)}>
            <span className="cd-hv-dot" />
            <span><b>{t('cf.current')}</b><small>{t('cf.backToFile')}</small></span>
          </button>
        )}
        {vs.data?.map((v) => (
          <button type="button" key={v.id} className={`cd-hv${v.ok ? '' : ' is-err'}${viewing?.id === v.id ? ' is-on' : ''}`} onClick={() => void open(v)}>
            <span className="cd-hv-dot" />
            <span>
              <b>{describe(v)}</b>
              <small>{relative(v.ts, now)}{v.user ? `, ${v.user}` : ''}</small>
            </span>
          </button>
        ))}
        {vs.data && !vs.data.length && <p className="cd-muted cd-pad">{t('cf.noVersions')}</p>}
        {vs.error && <p className="cd-muted cd-pad">{vs.error.message}</p>}
      </aside>

      <section className="cd-edw">
        <div className="cd-etb">
          <div className="cd-ftabs" role="tablist" aria-label={t('cf.files')}>
            {c.order.map((p) => {
              const d = mine[p] !== undefined && mine[p] !== c.files[p];
              return (
                <button key={p} type="button" role="tab" aria-selected={p === cur} className={`cd-ftab${p === cur ? ' is-on' : ''}`} title={p} onClick={() => setFile(p)}>
                  {d && <i aria-label={t('cf.unsaved')} />}
                  {p === c.main ? name(p) : p.slice(c.main.lastIndexOf('/') + 1)}
                </button>
              );
            })}
          </div>
          <span className="cd-sp" />
          {viewing ? (
            <>
              <Button onClick={() => setViewing(null)}>{t('cf.backToFile')}</Button>
              <Button variant="primary" icon="undo" loading={busy === 'restore'} onClick={() => void save(viewing.files, 'restore')}>{t('cf.restore')}</Button>
            </>
          ) : (
            <>
              <IconButton icon="wand" label={t('cf.format')} disabled={!!busy} onClick={() => setText(format(text))} />
              <IconButton icon="check" label={t('cf.check')} loading={busy === 'check'} disabled={!!busy} onClick={() => void runCheck()} />
              <Button disabled={!dirty.length || !!busy} onClick={discard}>{t('cf.discard')}</Button>
              <Button variant="primary" icon="check" loading={busy === 'save'} disabled={!dirty.length || !!busy} onClick={() => void save(Object.fromEntries(dirty))}>{t('editor.save')}</Button>
            </>
          )}
        </div>
        {viewing && (
          <div className="cd-note is-info cd-note--bar">
            <Icon name="history" size={16} />
            <span>{t('cf.viewing', { when: relative(viewing.ts, now), who: viewing.user || t('cf.someone') })}</span>
          </div>
        )}
        <CodeEditor value={text} onChange={viewing ? undefined : setText} readOnly={!!viewing} marks={marks} jump={jump} onCursor={(line, col) => setCursor({ line, col })} label={t('cf.editorLabel', { file: name(cur) })} />
        <div className="cd-sbar">
          {check ? (
            check.ok ? (
              <span className="cd-ok"><Icon name="check" size={15} />{t('cf.accepted')}</span>
            ) : (
              <span className="cd-bad"><Icon name="alert" size={15} />{t('cf.rejected')}</span>
            )
          ) : (
            <span>{t('cf.notChecked')}</span>
          )}
          {changedLines > 0 && !viewing && <span>{tn('cf.changed', { n: changedLines })}</span>}
          <span className="cd-sp" />
          <span>{t('cf.cursor', { line: cursor.line, col: cursor.col })}</span>
          <span className="cd-mono">{cur}</span>
        </div>
      </section>

      <aside className="cd-side">
        <Outline text={text} onJump={(line) => setJump({ line, n: Date.now() })} />
        <Checks check={check} text={text} onCheck={() => void runCheck()} busy={busy === 'check'} />
      </aside>
    </div>
  );
}

function describe(v: VersionMeta): string {
  if (v.kind === 'first') return t('ver.first');
  if (v.kind === 'external') return t('ver.external');
  if (!v.ok) return t('ver.failed');
  const parts = v.summary.split('|').filter((p) => p.includes(':'));
  if (v.kind === 'restore') return t('ver.restore');
  if (!parts.length) return t('ver.edited');
  return parts
    .map((p) => {
      const [k, names] = p.split(':');
      const list = names.split(',');
      return t(`ver.${k}`, { names: list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ') });
    })
    .join('; ');
}

function Outline({ text, onJump }: { text: string; onJump(line: number): void }) {
  const doc = useMemo(() => parse(text), [text]);
  const items = doc.blocks.map((b) => {
    if (b.kind === 'global') return { icon: 'cog', label: t('cf.global'), line: b.start + 1, off: false };
    if (b.kind === 'snippet') return { icon: 'code', label: t('cf.snippet', { name: b.node.name.slice(1, -1) }), line: b.start + 1, off: false };
    if (b.kind === 'import') return { icon: 'link', label: `import ${b.node.args.join(' ')}`, line: b.start + 1, off: false };
    if (b.kind === 'site') {
      const s = doc.sites.find((x) => x.start === b.start)!;
      return { icon: KIND_ICON[s.kind], label: s.addresses.join(', '), line: b.start + 1, off: s.disabled };
    }
    return { icon: 'code', label: b.node.name, line: b.start + 1, off: false };
  });
  return (
    <section className="cd-card">
      <h3><Icon name="blocks" size={16} />{t('cf.inFile')}<span className="cd-count">{tn('cf.blocks', { n: items.length })}</span></h3>
      <div className="cd-ol">
        {items.map((it, i) => (
          <button type="button" key={i} className={it.off ? 'is-off' : ''} onClick={() => onJump(it.line)}>
            <Icon name={it.icon} size={14} />
            <span>{it.label}</span>
            <small>{it.line}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function Checks({ check, text, onCheck, busy }: { check: Check | null; text: string; onCheck(): void; busy: boolean }) {
  const { data } = useCurrent()!;
  const probes = data.probes.use();
  const now = useNow();
  const doc = useMemo(() => parse(text), [text]);
  const names = useMemo(() => [...new Set(doc.sites.filter((s) => !s.disabled).flatMap((s) => publicNames(s.addresses)))], [doc]);
  const [dns, setDns] = useState<Record<string, DnsResult>>({});
  const [mine, setMine] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void myPublicAddresses().then((a) => live && setMine(a));
    for (const n of names) void checkDns(n).then((r) => live && setDns((d) => ({ ...d, [n]: r })));
    return () => {
      live = false;
    };
  }, [names.join(',')]);

  const down = doc.sites.filter((s) => !s.disabled && s.kind === 'proxy').filter((s) => {
    const u = upstreamURL(s.target);
    return u && probes.data?.[u] === false;
  });
  const elsewhere = names.filter((n) => dns[n]?.state === 'elsewhere' || dns[n]?.state === 'missing');
  const known = names.filter((n) => dns[n] && dns[n].state !== 'unknown');

  return (
    <section className="cd-card">
      <h3><Icon name="pulse" size={16} />{t('cf.checks')}</h3>
      <div className="cd-chk">
        {check ? (
          <div className={check.ok ? 'is-ok' : 'is-bad'}>
            <Icon name={check.ok ? 'check' : 'alert'} size={15} />
            <span>
              {check.ok ? t('cf.syntaxOk') : t('cf.syntaxBad')}
              <small className={check.ok ? '' : 'cd-pre'}>{check.ok ? t('cf.checkedAt', { when: relative(check.at, now) }) : check.output}</small>
            </span>
          </div>
        ) : (
          <div>
            <Icon name="info" size={15} />
            <span>
              {t('cf.syntaxUnknown')}
              <small><button type="button" className="cd-linkbtn" disabled={busy} onClick={onCheck}>{t('cf.checkNow')}</button></small>
            </span>
          </div>
        )}
        {down.map((s) => (
          <div key={s.start} className="is-warn">
            <Icon name="alert" size={15} />
            <span>
              {t('cf.backendDown', { target: s.target })}
              <small>{t('cf.backendDownText', { name: s.addresses[0] })}</small>
            </span>
          </div>
        ))}
        {names.length > 0 && known.length === names.length && !elsewhere.length && (
          <div className="is-ok">
            <Icon name="check" size={15} />
            <span>
              {tn('cf.dnsOk', { n: names.length })}
              <small>{t('cf.dnsOkText')}</small>
            </span>
          </div>
        )}
        {elsewhere.map((n) => (
          <div key={n} className="is-warn">
            <Icon name="globe" size={15} />
            <span>
              {dns[n].state === 'missing' ? t('cf.dnsMissing', { name: n }) : t('cf.dnsElsewhere', { name: n, ip: dns[n].addresses.join(', ') })}
              <small>{mine.length ? t('cf.dnsMine', { ip: mine.join(', ') }) : t('cf.dnsFix')}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
