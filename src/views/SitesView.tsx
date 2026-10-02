import { useEffect, useMemo, useState } from 'react';
import { upstreamURL, type SiteKind } from '../api/caddyfile';
import { useCurrent, useNow, type SiteRef } from '../api/state';
import { t } from '../i18n';
import { Button, Chip, EmptyState, Input, Sheet, Skeleton, useIsMobile } from '../kit';
import { go, nav, siteKey } from '../shell/nav';
import { KindIcon, Reach, TargetLabel, Tls, tlsState, Wire } from '../ui/bits';
import { ErrorBox } from '../ui/ErrorBox';
import { SiteEditor } from './SiteEditor';

type Filter = 'all' | 'proxy' | 'files' | 'redirect' | 'off';

const isLocal = (host: string) => /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);

export function targetOf(s: SiteRef, docker: boolean): { icon: string; text: string } {
  switch (s.kind) {
    case 'proxy': {
      const host = s.target.replace(/^\w+:\/\//, '').split(/[:\s]/)[0];
      return { icon: docker && !isLocal(host) ? 'box' : 'server', text: s.target };
    }
    case 'static':
    case 'php':
      return { icon: 'folder', text: s.root || '?' };
    case 'redirect':
      return { icon: 'globe', text: s.redirectTo };
    default:
      return { icon: 'code', text: t('sites.custom') };
  }
}

const matches = (s: SiteRef, f: Filter) =>
  f === 'all' ? true : f === 'off' ? s.disabled : s.disabled ? false : f === 'proxy' ? s.kind === 'proxy' : f === 'files' ? s.kind === 'static' || s.kind === 'php' : s.kind === 'redirect';

const hasHttps = (s: SiteRef) => s.addresses.some((a) => !a.startsWith('http://') && !/:80$/.test(a) && !a.startsWith(':'));

/** Sites (design 035 b): list rows wired to what answers them, editor on the right. */
export function SitesView() {
  const cur = useCurrent()!;
  const { inst, data } = cur;
  const cfg = data.config.use();
  const probes = data.probes.use();
  const presented = data.presented.use();
  const n = nav.use();
  const now = useNow();
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    void data.config.ensure();
    const id = setInterval(() => {
      if (!document.hidden) void data.probes.refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [data]);

  const sites = cfg.data?.sites ?? [];
  const open = n.site === 'new' ? 'new' : sites.find((s) => siteKey(s) === n.site);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sites.filter((s) => matches(s, filter) && (!needle || [...s.addresses, s.target, s.root, s.redirectTo].some((x) => x.toLowerCase().includes(needle))));
  }, [sites, q, filter]);

  if (cfg.error && !cfg.data) return <ErrorBox error={cfg.error} onRetry={() => void data.config.refresh()} />;
  if (!cfg.data) return <div className="cd-lst"><Skeleton lines={6} /></div>;

  const count = (f: Filter) => sites.filter((s) => matches(s, f)).length;
  const chips: [Filter, string][] = [['all', t('sites.f.all')], ['proxy', t('sites.f.proxy')], ['files', t('sites.f.files')], ['redirect', t('sites.f.redirect')], ['off', t('sites.f.off')]];
  const close = () => go('sites', { site: null });
  const editor = open ? <SiteEditor key={open === 'new' ? 'new' : siteKey(open)} site={open === 'new' ? null : open} onClose={close} /> : null;

  return (
    <div className="cd-split">
      <section className="cd-lst" aria-label={t('tab.sites')}>
        <div className="cd-lh">
          <Input fieldClassName="cd-search" compact icon="search" value={q} placeholder={t('sites.filter')} aria-label={t('sites.filter')} onChange={(e) => setQ(e.target.value)} />
          <div className="cd-chips">
            {chips.filter(([f]) => f === 'all' || count(f) > 0).map(([f, label]) => (
              <Chip key={f} pressed={filter === f} count={count(f)} onClick={() => setFilter(f)}>{label}</Chip>
            ))}
          </div>
        </div>
        {!sites.length ? (
          <EmptyState icon="route" hue="term" title={t('sites.none')} text={t('sites.noneText')} action={<Button variant="primary" icon="plus" onClick={() => go('sites', { site: 'new' })}>{t('sites.add')}</Button>} />
        ) : !list.length ? (
          <p className="cd-muted cd-pad">{t('sites.noMatch')}</p>
        ) : (
          list.map((s) => {
            const url = s.kind === 'proxy' ? upstreamURL(s.target) : null;
            const up = url ? probes.data?.[url] : undefined;
            const name = s.addresses[0].replace(/^https?:\/\//, '').replace(/:\d+$/, '');
            const cert = presented.data?.[name] ?? undefined;
            const st = tlsState(cert, false, hasHttps(s), now);
            const tg = targetOf(s, inst.kind === 'docker');
            const k = siteKey(s);
            return (
              <button
                type="button"
                key={k}
                className={`cd-wr${k === n.site ? ' is-sel' : ''}${s.disabled ? ' is-off' : ''}${up === false && !s.disabled ? ' is-down' : ''}`}
                onClick={() => go('sites', { site: k === n.site ? null : k })}
                aria-pressed={k === n.site}
              >
                <KindIcon kind={s.kind as SiteKind} />
                <span className="cd-wr-dm">
                  <b>
                    {s.addresses[0]}
                    {s.addresses.length > 1 && <span className="cd-more"> +{s.addresses.length - 1}</span>}
                  </b>
                  {s.disabled ? <span className="cd-tls is-off">{t('sites.isOff')}</span> : presented.data || st.state === 'off' ? <Tls {...st} /> : <span className="cd-tls is-none">…</span>}
                </span>
                <Wire down={up === false && !s.disabled} />
                <span className="cd-wr-to">
                  <TargetLabel {...tg} />
                  {!s.disabled && <Reach up={up} />}
                </span>
              </button>
            );
          })
        )}
      </section>
      {editor && (mobile ? <Sheet open onClose={close} title={open === 'new' ? t('editor.newTitle') : (open as SiteRef).addresses[0]}>{editor}</Sheet> : editor)}
    </div>
  );
}
