import { useEffect, useMemo, useState } from 'react';
import { reloadOnly } from '../api/actions';
import { checkDns, myPublicAddresses, type DnsResult } from '../api/dns';
import { acmeReason, tlsFailures, type LogEntry } from '../api/logs';
import { errorText } from '../api/run';
import { useCurrent, useNow, type CertView } from '../api/state';
import { t, tn } from '../i18n';
import { Button, Dialog, EmptyState, Icon, IconButton, Skeleton, toast } from '../kit';
import { getSdk } from '../sdk';
import { go } from '../shell/nav';
import { ErrorBox } from '../ui/ErrorBox';
import { clock, dateShort, daysLeft, duration, relative } from '../ui/format';

type State = 'needs' | 'renew' | 'ok' | 'local' | 'expired';

function stateOf(c: CertView, failing: boolean, now: number): State {
  const days = daysLeft(c.notAfter, now);
  if (days < 0) return 'expired';
  if (c.issuerKind === 'local') return 'local';
  if (failing || days < 7) return 'needs';
  if (c.notAfter - now < (c.notAfter - c.notBefore) / 3) return 'renew';
  return 'ok';
}

const ISSUER_TONE: Record<CertView['issuerKind'], string> = { letsencrypt: 'file', zerossl: 'sw', local: 'usr', other: 'ov' };

/** Certificates (design 038 a): counts, life bars sorted by time left, details on the right. */
export function CertsView() {
  const { inst, data } = useCurrent()!;
  const certs = data.certs.use();
  const logs = data.logs.use();
  const now = useNow();
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void data.certs.ensure(60_000);
    void data.logs.ensure(60_000);
  }, [data]);

  const failures = useMemo(() => tlsFailures(logs.data ?? []), [logs.data]);
  const failingFor = (c: CertView) => c.names.flatMap((n) => failures.get(n) ?? []);

  if (certs.error && !certs.data) return <ErrorBox error={certs.error} onRetry={() => void data.certs.refresh()} />;
  if (!certs.data) return <Skeleton lines={8} />;
  const list = certs.data;
  if (!list.length)
    return <EmptyState icon="cert" hue="term" title={t('certs.none')} text={inst.running ? t('certs.noneText') : t('certs.noneStopped')} />;

  const rows = list.map((c) => ({ c, failing: failingFor(c), st: stateOf(c, failingFor(c).length > 0, now) }));
  const count = (s: State) => rows.filter((r) => r.st === s).length;
  const selected = rows.find((r) => r.c.names.join(',') === sel) ?? rows.find((r) => r.st === 'needs' || r.st === 'expired') ?? rows[0];

  return (
    <div className="cd-certs">
      <div className="cd-sum">
        <div><b>{list.length}</b><small>{tn('certs.count', { n: list.length })}</small></div>
        <div className={count('needs') + count('expired') ? 'is-warn' : ''}><b>{count('needs') + count('expired')}</b><small>{t('certs.needsYou')}</small></div>
        <div><b>{count('renew')}</b><small>{t('certs.renewing')}</small></div>
        <div className={count('expired') ? 'is-err' : ''}><b>{count('expired')}</b><small>{t('certs.expired')}</small></div>
      </div>
      <div className="cd-split">
        <section className="cd-cl" aria-label={t('tab.certs')}>
          <div className="cd-clh"><span>{t('certs.covers')}</span><span>{t('certs.timeLeft')}</span><span className="cd-num">{t('certs.endsIn')}</span></div>
          {rows.map(({ c, failing, st }) => {
            const days = daysLeft(c.notAfter, now);
            const life = c.notAfter - c.notBefore;
            const pct = Math.max(2, Math.min(100, ((c.notAfter - now) / life) * 100));
            const k = c.names.join(',');
            return (
              <button type="button" key={k} className={`cd-cr is-${st}${selected?.c === c ? ' is-sel' : ''}`} onClick={() => setSel(k)} aria-pressed={selected?.c === c}>
                <span className="cd-cn">
                  <b>{c.names.slice(0, 2).join(', ')}{c.names.length > 2 ? ` +${c.names.length - 2}` : ''}</b>
                  <span className={`cd-iss hue-${ISSUER_TONE[c.issuerKind]}`}>{c.issuer}</span>
                </span>
                <span className="cd-life" title={t('certs.lifeTitle', { n: Math.max(0, days), total: Math.round(life / 86400e3) })}>
                  {c.issuerKind !== 'local' && <span className="cd-rw" />}
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className={`cd-days is-${st}`}>{days < 0 ? t('certs.ended') : days < 1 ? duration(c.notAfter - now) : tn('certs.days', { n: days })}</span>
                {why(st, failing) && <span className={`cd-why is-${st}`}><Icon name={st === 'renew' ? 'refresh' : st === 'local' ? 'info' : 'alert'} size={15} />{why(st, failing)}</span>}
              </button>
            );
          })}
          <p className="cd-muted cd-pad">{t('certs.footnote')}</p>
        </section>
        {selected && <Detail c={selected.c} failing={selected.failing} st={selected.st} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

function why(st: State, failing: LogEntry[]): string {
  if (failing.length) return t(`acme.${acmeReason(`${failing[0].msg} ${failing[0].error ?? ''}`)}.short`);
  if (st === 'renew') return t('certs.renewNow');
  if (st === 'local') return t('certs.localShort');
  if (st === 'expired') return t('certs.expiredShort');
  if (st === 'needs') return t('certs.soonShort');
  return '';
}

function Detail({ c, failing, st, onClose }: { c: CertView; failing: LogEntry[]; st: State; onClose(): void }) {
  const { inst, data } = useCurrent()!;
  const now = useNow();
  const [dns, setDns] = useState<DnsResult | null>(null);
  const [mine, setMine] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const name = c.names[0];
  useEffect(() => {
    setDns(null);
    if (!failing.length) return;
    void checkDns(name).then(setDns);
    void myPublicAddresses().then(setMine);
  }, [name, failing.length]);

  const reason = failing.length ? acmeReason(`${failing[0].msg} ${failing[0].error ?? ''}`) : null;
  const retry = async () => {
    setBusy(true);
    try {
      const r = await reloadOnly(inst);
      if (r.ok) toast.ok(t('certs.retried'), t('certs.retriedText'));
      else toast.err(t('shell.reloadFailed'), r.output);
    } catch (e) {
      toast.err(t('shell.reloadFailed'), errorText(e));
    } finally {
      setBusy(false);
      setTimeout(() => void data.logs.refresh(), 15000);
    }
  };

  return (
    <aside className="cd-det" aria-label={name}>
      <div className="cd-edh">
        <span className={`cd-lk2 is-${st}`}><Icon name="lock" /></span>
        <div>
          <b>{name}</b>
          <span>{t('certs.issuerEnds', { issuer: c.issuer, date: dateShort(c.notAfter) })}</span>
        </div>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </div>
      {reason && (
        <div className="cd-note is-warn">
          <Icon name="alert" size={17} />
          <span>
            <b>{t('certs.failedTimes', { n: failing.length })}</b>{' '}
            {reason === 'dns' && dns?.state === 'elsewhere'
              ? t('acme.dnsElsewhere', { name, ip: dns.addresses.join(', '), mine: mine.join(', ') || '?' })
              : t(`acme.${reason}.long`, { name })}
          </span>
        </div>
      )}
      {st === 'local' && <div className="cd-note is-info"><Icon name="shield" size={17} /><span>{t('certs.localLong')}</span></div>}
      <dl className="cd-kv">
        <dt>{t('certs.k.covers')}</dt><dd>{c.names.join(', ')}</dd>
        <dt>{t('certs.k.from')}</dt><dd>{dateShort(c.notBefore)}</dd>
        <dt>{t('certs.k.ends')}</dt><dd>{dateShort(c.notAfter)}, {relative(c.notAfter, now)}</dd>
        <dt>{t('certs.k.key')}</dt><dd>{c.key}</dd>
        {c.fingerprint && <><dt>{t('certs.k.fp')}</dt><dd className="cd-mono" title={c.fingerprint}>{c.fingerprint.slice(0, 8)}…{c.fingerprint.slice(-5)}</dd></>}
        <dt>{t('certs.k.file')}</dt><dd className="cd-mono" title={c.path}>…/{c.path.split('/').slice(-3).join('/')}</dd>
      </dl>
      {failing.length > 0 && (
        <>
          <div className="cd-la">{t('certs.attempts')}</div>
          {failing.slice(0, 3).map((f, i) => (
            <div className="cd-att" key={i}>
              <span className="cd-x"><Icon name="close" size={12} /></span>
              <span>{relative(f.ts, now)}, {clock(f.ts)}<small>{(f.error ?? f.msg).slice(0, 180)}</small></span>
            </div>
          ))}
        </>
      )}
      <div className="cd-dact">
        <Button icon="logs" onClick={() => go('logs', { logQuery: name })}>{t('certs.log')}</Button>
        <Button icon="externallink" onClick={() => getSdk().openExternal(`https://${name.replace(/^\*\./, '')}`)}>{t('certs.open')}</Button>
        {st === 'local' ? (
          <Button
            variant="primary"
            icon="shield"
            onClick={async () => setRoot((await data.backend.rootCA()) ?? '')}
          >
            {t('certs.rootCA')}
          </Button>
        ) : (
          failing.length > 0 && <Button variant="primary" icon="refresh" loading={busy} onClick={() => void retry()}>{t('certs.retry')}</Button>
        )}
      </div>
      <Dialog open={root !== null} onClose={() => setRoot(null)} title={t('certs.rootTitle')} description={t('certs.rootText')} icon="shield" size="lg"
        footer={<><Button onClick={() => setRoot(null)}>{t('common.close')}</Button><Button variant="primary" icon="copy" disabled={!root} onClick={() => { void navigator.clipboard?.writeText(root ?? '').then(() => toast.ok(t('certs.copied'))); }}>{t('common.copy')}</Button></>}>
        {root ? <pre className="cd-pem">{root}</pre> : <p>{t('certs.rootMissing')}</p>}
      </Dialog>
      {inst.kind === 'docker' && <p className="cd-muted">{t('certs.inContainer', { path: inst.dataDir ?? '' })}</p>}
    </aside>
  );
}
