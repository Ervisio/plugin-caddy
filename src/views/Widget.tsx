import { useEffect } from 'react';
import { upstreamURL } from '../api/caddyfile';
import { detection, initSelection, useCurrent } from '../api/state';
import { useMaybe } from '../api/store';
import { t, tn } from '../i18n';
import { Button } from '../kit';
import { getSdk } from '../sdk';
import { Wire } from '../ui/bits';

/**
 * Overview widget (design 042 b): state line, then sites as small wired rows, problems first. It never asks for
 * administrator rights: on the system service it reads the Caddyfile and checks backends as the user.
 */
export function SitesWidget() {
  const det = detection.use();
  const cur = useCurrent();
  const cfg = useMaybe(cur?.data.config);
  const probes = useMaybe(cur?.data.probes);

  useEffect(() => {
    void initSelection();
  }, []);
  useEffect(() => {
    if (cur && !cur.inst.unsupported) void cur.data.config.ensure();
    const id = setInterval(() => cur && !document.hidden && void cur.data.probes.refresh(), 60_000);
    return () => clearInterval(id);
  }, [cur?.inst.key]);

  const open = () => getSdk().open('caddy');
  if (!det.data) return <p className="cd-w-muted">{det.error ? det.error.message : t('shell.looking')}</p>;
  if (!cur) return <p className="cd-w-muted">{t('widget.none')}</p>;
  const { inst } = cur;
  const sites = (cfg?.data?.sites ?? []).filter((s) => !s.disabled);
  const rows = sites
    .map((s) => {
      const u = s.kind === 'proxy' ? upstreamURL(s.target) : null;
      const up = u ? probes?.data?.[u] : undefined;
      const to = s.kind === 'proxy' ? s.target.replace(/^\w+:\/\//, '').split(/\s/)[0] : s.kind === 'redirect' ? s.redirectTo.replace(/^https?:\/\//, '') : s.root;
      return { s, up, to };
    })
    .sort((a, b) => Number(a.up !== false) - Number(b.up !== false));
  const shown = rows.slice(0, 5);
  return (
    <div className="cd-w">
      <div className="cd-w-st">
        <i className={inst.running ? 'is-ok' : ''} />
        <span>
          <b>{inst.running ? t('inst.running') : t('inst.stopped')}</b>, {tn('inst.sites', { n: sites.length })}
        </span>
      </div>
      {cfg?.error && !cfg.data ? <p className="cd-w-muted">{cfg.error.message}</p> : null}
      <div className="cd-w-rows">
        {shown.map(({ s, up, to }) => (
          <button type="button" key={`${s.file}#${s.start}`} className={`cd-w-r${up === false ? ' is-down' : ''}`} onClick={open}>
            <b>{s.addresses[0]}</b>
            <Wire down={up === false} />
            <span className={`cd-w-to${up === false ? ' is-down' : ''}`}><i className={up === false ? 'is-down' : up ? 'is-ok' : ''} />{to}</span>
          </button>
        ))}
      </div>
      {rows.length > shown.length ? (
        <Button size="sm" variant="ghost" onClick={open}>{tn('widget.more', { n: rows.length - shown.length })}</Button>
      ) : (
        !rows.length && cfg?.data && <Button size="sm" onClick={open}>{t('widget.open')}</Button>
      )}
    </div>
  );
}
