import { useEffect, useState } from 'react';
import { reloadOnly } from '../api/actions';
import { errorText } from '../api/run';
import { detection, initSelection, lookInDocker, useCurrent, useNow } from '../api/state';
import { useMaybe } from '../api/store';
import { t } from '../i18n';
import { Button, DropdownMenu, EmptyState, IconButton, Tabs, toast } from '../kit';
import { getSdk } from '../sdk';
import { duration } from '../ui/format';
import { CaddyfileView } from '../views/CaddyfileView';
import { CertsView } from '../views/CertsView';
import { LogsView } from '../views/LogsView';
import { SitesView } from '../views/SitesView';
import { InstanceMenu } from './InstanceMenu';
import { go, nav, type TabId } from './nav';

/** The page: header with the server switcher, tabs, and the tab's view. */
export function App() {
  const det = detection.use();
  const cur = useCurrent();
  const n = nav.use();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void initSelection();
  }, []);

  const cfg = useMaybe(cur?.data.config);
  const certs = useMaybe(cur?.data.certs);
  useEffect(() => {
    if (cur && !cur.inst.unsupported) void cur.data.config.ensure();
  }, [cur?.inst.key, cur?.inst.container?.id]);

  if (!det.data) {
    if (det.error)
      return (
        <div className="cd-root hue-term">
          <EmptyState icon="alert" hue="svc" title={t('shell.detectFailed')} text={det.error.message} action={<Button icon="refresh" onClick={() => void detection.refresh()}>{t('common.retry')}</Button>} />
        </div>
      );
    return <div className="cd-root hue-term"><div className="cd-loading">{t('shell.looking')}</div></div>;
  }

  if (!cur) return <NotFound skipped={det.data.dockerSkipped} dockerError={det.data.dockerError} />;
  const { inst, data } = cur;

  const service = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      await data.backend.service(action);
      toast.ok(t(`shell.done.${action}`));
      await detection.refresh();
    } catch (e) {
      toast.err(t(`shell.fail.${action}`), errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reload = async () => {
    setBusy('reload');
    try {
      const r = await reloadOnly(inst);
      if (r.ok) toast.ok(t('shell.reloaded'), t('shell.reloadedText'));
      else toast.err(t('shell.reloadFailed'), r.output);
      void data.config.refresh();
    } catch (e) {
      toast.err(t('shell.reloadFailed'), errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const status = inst.running
    ? inst.since
      ? t('shell.runningFor', { time: duration(now - inst.since) })
      : t('shell.running')
    : t('shell.stopped');

  const sites = cfg?.data?.sites.length;
  const tabs = [
    { id: 'sites', label: t('tab.sites'), icon: 'route', count: sites },
    { id: 'caddyfile', label: t('tab.caddyfile'), icon: 'code' },
    { id: 'certs', label: t('tab.certs'), icon: 'cert', count: certs?.data?.length },
    { id: 'logs', label: t('tab.logs'), icon: 'logs' },
  ];

  return (
    <div className="cd-root hue-term">
      <header className="cd-head">
        <h1>Caddy</h1>
        <InstanceMenu />
        <div className="cd-sp" />
        <span className="cd-status">{status}</span>
        {inst.running ? (
          <Button icon="refresh" loading={busy === 'reload'} disabled={!!inst.unsupported && inst.unsupported !== 'path'} onClick={reload}>{t('shell.reload')}</Button>
        ) : (
          <Button icon="play" loading={busy === 'start'} onClick={() => service('start')}>{t('common.start')}</Button>
        )}
        <DropdownMenu
          aria-label={t('shell.more')}
          items={[
            { id: 'restart', label: t('common.restart'), icon: 'refresh', disabled: !inst.running, onSelect: () => void service('restart') },
            inst.running
              ? { id: 'stop', label: t('common.stop'), icon: 'stop', danger: true, onSelect: () => void service('stop') }
              : { id: 'start', label: t('common.start'), icon: 'play', onSelect: () => void service('start') },
            { id: 'docs', label: t('shell.docs'), icon: 'externallink', onSelect: () => getSdk().openExternal('https://caddyserver.com/docs/caddyfile') },
          ]}
          trigger={(p) => <IconButton icon="more" label={t('shell.more')} {...p} />}
        />
        {!inst.unsupported && (
          <Button variant="primary" icon="plus" onClick={() => go('sites', { site: 'new' })}>{t('sites.add')}</Button>
        )}
      </header>

      {inst.unsupported ? (
        <Unsupported />
      ) : (
        <>
          <Tabs variant="pill" hue="term" items={tabs} value={n.tab} onChange={(id) => go(id as TabId)} aria-label={t('tab.aria')} className="cd-tabs" />
          <div className="cd-view">
            {n.tab === 'sites' && <SitesView />}
            {n.tab === 'caddyfile' && <CaddyfileView />}
            {n.tab === 'certs' && <CertsView />}
            {n.tab === 'logs' && <LogsView />}
          </div>
        </>
      )}
    </div>
  );
}

function Unsupported() {
  const cur = useCurrent()!;
  const why = cur.inst.unsupported!;
  return (
    <EmptyState
      icon="info"
      hue="term"
      title={t(`unsupported.${why}.title`)}
      text={t(`unsupported.${why}.text`, { path: cur.inst.configPath })}
      action={why === 'labels' ? <Button icon="externallink" onClick={() => getSdk().openExternal('https://github.com/lucaslorentz/caddy-docker-proxy')}>{t('unsupported.labels.docs')}</Button> : undefined}
    />
  );
}

function NotFound({ skipped, dockerError }: { skipped: boolean; dockerError?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="cd-root hue-term">
      <header className="cd-head"><h1>Caddy</h1></header>
      <EmptyState
        icon="globe"
        hue="term"
        title={t('empty.title')}
        text={
          <>
            <span>{t('empty.text')}</span>
            {skipped && <span className="cd-block">{t('empty.dockerSkipped')}</span>}
            {dockerError && <span className="cd-block">{t('empty.dockerError', { error: dockerError })}</span>}
          </>
        }
        action={
          <div className="cd-row">
            {skipped && (
              <Button
                icon="unlock"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await lookInDocker();
                  setBusy(false);
                }}
              >
                {t('menu.lookDocker')}
              </Button>
            )}
            <Button icon="refresh" onClick={() => void detection.refresh()}>{t('menu.again')}</Button>
            <Button variant="ghost" icon="externallink" onClick={() => getSdk().openExternal('https://caddyserver.com/docs/install')}>{t('empty.install')}</Button>
          </div>
        }
      />
    </div>
  );
}
