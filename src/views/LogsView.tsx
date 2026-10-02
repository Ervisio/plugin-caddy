import { useEffect, useMemo, useRef, useState } from 'react';
import { explain, parseLine, statusClass, traffic, type LogEntry, type StatusClass } from '../api/logs';
import { logFiles, useCurrent, useNow } from '../api/state';
import { t, tn } from '../i18n';
import { Button, Chip, EmptyState, Icon, IconButton, Input, Select, Skeleton, toast } from '../kit';
import { go, nav, siteKey } from '../shell/nav';
import { ErrorBox } from '../ui/ErrorBox';
import { clock, num } from '../ui/format';

type ChipId = 'all' | StatusClass | 'caddy';
type Range = 'hour' | 'day' | 'all';
const MAX = 20000;

const tone = (s: number) => (s >= 500 ? 'err' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');

function Status({ s }: { s: number }) {
  return <span className={`cd-sc is-${tone(s)}`}>{s || '–'}</span>;
}

/** Logs (design 039 b): traffic first, then the stream and the details of one line. */
export function LogsView() {
  const { inst, data } = useCurrent()!;
  const logs = data.logs.use();
  const cfg = data.config.use().data;
  const n = nav.use();
  const now = useNow();
  const [q, setQ] = useState(n.logQuery);
  const [chip, setChip] = useState<ChipId>(n.logQuery ? 'all' : 'all');
  const [range, setRange] = useState<Range>('hour');
  const [live, setLive] = useState(true);
  const [sel, setSel] = useState<LogEntry | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (n.logQuery) {
      setQ(n.logQuery);
      // a domain from Certificates: its TLS messages are Caddy's own lines
      if (!n.logQuery.match(/^\d/)) setChip('caddy');
      nav.set((x) => ({ ...x, logQuery: '' }));
    }
  }, [n.logQuery]);

  useEffect(() => {
    void data.config.ensure();
    void data.logs.refresh();
  }, [data]);

  // Live: append new lines to the loaded ones.
  useEffect(() => {
    if (!live || !logs.data) return;
    const push = (src: string) => (l: string) => {
      const e = parseLine(l, src);
      if (!e) return;
      data.logs.set((s) => ({ ...s, data: [...(s.data ?? []).slice(-MAX), e] }));
    };
    const handles = [data.backend.followLogs(push(inst.kind === 'docker' ? 'container' : 'journal'))];
    for (const f of logFiles(inst, cfg)) handles.push(data.backend.followFile(f, push(f)));
    return () => handles.forEach((h) => h.close());
  }, [live, !!logs.data, data, cfg]);

  const all = logs.data ?? [];
  const from = range === 'hour' ? now - 3600e3 : range === 'day' ? now - 86400e3 : 0;
  const tr = useMemo(() => traffic(all, Date.now()), [all, now]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: LogEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < 500; i--) {
      const e = all[i];
      if (e.ts < from) break;
      if (chip === 'caddy' ? !!e.req : !e.req) continue;
      if (chip !== 'all' && chip !== 'caddy' && statusClass(e.req!.status) !== chip) continue;
      if (needle && !e.raw.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }, [all, q, chip, from]);

  if (logs.error && !logs.data) return <ErrorBox error={logs.error} onRetry={() => void data.logs.refresh()} />;
  if (!logs.data) return <Skeleton lines={10} />;

  const noAccess = (cfg?.sites ?? []).filter((s) => !s.disabled && !s.options.accessLog).length;
  const peak = Math.max(1, ...tr.buckets.map((b) => b[0] + b[1] + b[2]));
  const chips: [ChipId, string][] = [['all', t('logs.c.all')], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['5xx', '5xx'], ['caddy', t('logs.c.caddy')]];

  return (
    <div className="cd-logs">
      <div className="cd-top3">
        <section className="cd-card">
          <h3>{t('logs.lastHour')}<span className="cd-count">{tr.total ? t('logs.totals', { n: num(tr.total), pct: ((tr.errors / tr.total) * 100).toFixed(1) }) : t('logs.noRequests')}</span></h3>
          <div className="cd-hist" role="img" aria-label={t('logs.histAria', { n: tr.total })}>
            {tr.buckets.map((b, i) => (
              <span key={i}>
                <i className="is-ok" style={{ height: `${(b[0] / peak) * 100}%` }} />
                <i className="is-warn" style={{ height: `${(b[1] / peak) * 100}%` }} />
                <i className="is-err" style={{ height: `${(b[2] / peak) * 100}%` }} />
              </span>
            ))}
          </div>
        </section>
        <section className="cd-card">
          <h3>{t('logs.top')}</h3>
          <div className="cd-kvl">
            {tr.top.length ? tr.top.map((x) => (
              <button type="button" key={x.key} onClick={() => setQ(x.key.slice(x.key.indexOf('/')))}>
                <em style={{ width: `${(x.n / tr.top[0].n) * 100}%` }} />
                <span>{x.key}</span>
                <b>{num(x.n)}</b>
              </button>
            )) : <p className="cd-muted">{t('logs.nothingYet')}</p>}
          </div>
        </section>
        <section className="cd-card">
          <h3>{t('logs.offenders')}</h3>
          <div className="cd-kvl">
            {tr.offenders.length ? tr.offenders.map((x) => (
              <button type="button" key={x.ip} className={x.why === 'probing' || x.status === 401 ? 'is-bad' : ''} onClick={() => setQ(x.ip)}>
                <em style={{ width: `${(x.n / tr.offenders[0].n) * 100}%` }} />
                <span>{x.why === 'probing' ? t('logs.probing', { ip: x.ip, path: x.path }) : t('logs.statusOf', { ip: x.ip, status: x.status })}</span>
                <b>{num(x.n)}</b>
              </button>
            )) : <p className="cd-muted">{t('logs.noErrors')}</p>}
          </div>
        </section>
      </div>
      {noAccess > 0 && !tr.total && (
        <div className="cd-note is-info"><Icon name="info" size={17} /><span>{tn('logs.noAccess', { n: noAccess })} <button type="button" className="cd-linkbtn" onClick={() => go('sites')}>{t('logs.toSites')}</button></span></div>
      )}
      <div className="cd-split">
        <section className="cd-stream">
          <div className="cd-fbar">
            <Input fieldClassName="cd-search" compact icon="search" value={q} placeholder={t('logs.search')} aria-label={t('logs.search')} onChange={(e) => setQ(e.target.value)} end={q ? <IconButton icon="close" size="sm" label={t('common.close')} onClick={() => setQ('')} /> : undefined} />
            <div className="cd-chips">{chips.map(([c, l]) => <Chip key={c} pressed={chip === c} onClick={() => setChip(c)}>{l}</Chip>)}</div>
            <div className="cd-range"><Select compact value={range} onChange={(v) => setRange(v as Range)} options={[{ value: 'hour', label: t('logs.r.hour') }, { value: 'day', label: t('logs.r.day') }, { value: 'all', label: t('logs.r.all') }]} /></div>
            <button type="button" className={`cd-live${live ? ' is-on' : ''}`} aria-pressed={live} onClick={() => setLive((v) => !v)}><i />{t('logs.live')}</button>
          </div>
          <div className="cd-rows" role="list">
            {!shown.length && <EmptyState icon="logs" hue="term" title={t('logs.empty')} text={chip === 'caddy' ? t('logs.emptyCaddy') : t('logs.emptyText')} />}
            {shown.map((e, i) =>
              e.req ? (
                <button type="button" role="listitem" key={i} className={`cd-r${sel === e ? ' is-sel' : ''}`} onClick={() => setSel(e)}>
                  <span className="cd-t">{clock(e.ts)}</span>
                  <Status s={e.req.status} />
                  <span className="cd-s">{e.req.host}</span>
                  <span className="cd-p"><b>{e.req.method}</b> {e.req.uri}</span>
                  <span className="cd-n">{e.req.ms} ms</span>
                  <span className="cd-n cd-ip">{e.req.ip}</span>
                </button>
              ) : (
                <button type="button" role="listitem" key={i} className={`cd-r cd-r--msg${sel === e ? ' is-sel' : ''}`} onClick={() => setSel(e)}>
                  <span className="cd-t">{clock(e.ts)}</span>
                  <span className={`cd-lv is-${e.level}`}>{e.level}</span>
                  <span className="cd-s cd-mono">{e.logger || '–'}</span>
                  <span className="cd-p">{e.msg}{e.error ? `: ${e.error}` : ''}</span>
                </button>
              ),
            )}
          </div>
        </section>
        {sel && <Detail e={sel} all={all} onClose={() => setSel(null)} onIp={(ip) => setQ(ip)} />}
      </div>
    </div>
  );
}

function Detail({ e, all, onClose, onIp }: { e: LogEntry; all: LogEntry[]; onClose(): void; onIp(ip: string): void }) {
  const { inst, data } = useCurrent()!;
  const cfg = data.config.use().data;
  const ex = explain(e, all);
  const site = e.req ? cfg?.sites.find((s) => s.addresses.some((a) => a.replace(/^https?:\/\//, '').replace(/:\d+$/, '') === e.req!.host)) : undefined;
  let pretty = e.raw;
  try {
    pretty = JSON.stringify(JSON.parse(e.raw), null, 2);
  } catch {
    /* not JSON */
  }
  return (
    <aside className="cd-det cd-det--log" aria-label={t('logs.detail')}>
      <div className="cd-edh">
        {e.req ? <Status s={e.req.status} /> : <span className={`cd-lv is-${e.level}`}>{e.level}</span>}
        <div>
          <b className="cd-mono">{e.req ? `${e.req.method} ${e.req.host}${e.req.uri}` : e.logger || t('logs.message')}</b>
          <span>{e.req ? t('logs.from', { time: clock(e.ts), ip: e.req.ip, ms: e.req.ms }) : clock(e.ts)}</span>
        </div>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </div>
      {ex && (
        <div className={`cd-note ${ex.kind === 'probe' || ex.kind === 'notfound' ? 'is-info' : 'is-err'}`}>
          <Icon name={ex.kind === 'probe' ? 'shield' : 'alert'} size={16} />
          <span>{t(`explain.${ex.kind}`, { upstream: 'upstream' in ex ? ex.upstream || site?.target || '?' : '' })}</span>
        </div>
      )}
      {e.req && (
        <div className="cd-dact">
          {site && <Button icon="route" onClick={() => go('sites', { site: siteKey(site) })}>{t('logs.editSite')}</Button>}
          <Button icon="filter" onClick={() => onIp(e.req!.ip)}>{t('logs.onlyIp')}</Button>
        </div>
      )}
      <pre className="cd-js">{pretty}</pre>
      <div className="cd-dact">
        <Button variant="ghost" icon="copy" onClick={() => void navigator.clipboard?.writeText(e.raw).then(() => toast.ok(t('logs.copied')))}>{t('common.copy')}</Button>
        <span className="cd-muted">{e.source === 'journal' ? t('logs.srcJournal') : e.source === 'container' ? t('logs.srcContainer', { name: inst.name }) : e.source}</span>
      </div>
    </aside>
  );
}
