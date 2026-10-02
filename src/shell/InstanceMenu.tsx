import { useEffect, useRef, useState } from 'react';
import type { Instance } from '../api/instances';
import { chooseInstance, detection, forInstance, lookInDocker, useInstance } from '../api/state';
import { t, tn } from '../i18n';
import { Button, Icon } from '../kit';

const where = (i: Instance) => (i.kind === 'system' ? t('inst.system') : t('inst.docker'));

function note(i: Instance): string {
  if (i.kind === 'system') return i.running ? t('inst.noteSystem') : t('inst.noteSystemOff');
  const c = i.container!;
  return [c.stack ? t('inst.stack', { name: c.stack }) : '', t('inst.image', { image: c.image })].filter(Boolean).join(', ');
}

function configLine(i: Instance): string {
  if (i.kind === 'system') return i.configPath;
  if (i.configHost) return t('inst.mounted', { host: i.configHost, path: i.configPath });
  return t('inst.notMounted', { path: i.configPath });
}

function Item({ i, on, onPick }: { i: Instance; on: boolean; onPick(): void }) {
  const cfg = forInstance(i).config.use();
  const sites = cfg.data?.sites.length;
  return (
    <button type="button" role="menuitemradio" aria-checked={on} className={`cd-mi${on ? ' is-on' : ''}`} onClick={onPick}>
      <span className={`cd-ib${i.kind === 'docker' ? ' cd-ib--dk' : ''}`}><Icon name={i.kind === 'docker' ? 'box' : 'server'} /></span>
      <span className="cd-mi-tx">
        <b>
          {i.name} <small>{where(i)}{i.version ? `, ${i.version}` : ''}</small>
        </b>
        <span>{note(i)}</span>
        <span className="cd-mono">{configLine(i)}</span>
      </span>
      <span className="cd-mi-rt">
        <span className={`cd-st${i.running ? '' : ' is-off'}`}><i />{i.running ? t('inst.running') : t('inst.stopped')}</span>
        {sites !== undefined && <small>{tn('inst.sites', { n: sites })}</small>}
      </span>
    </button>
  );
}

/** The pill next to the title, and its menu with every Caddy found (design 040 a). */
export function InstanceMenu() {
  const det = detection.use();
  const cur = useInstance();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!cur || !det.data) return null;
  const list = det.data.instances;
  return (
    <div className="cd-instw" ref={ref}>
      <button type="button" className={`cd-inst${open ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`cd-ib${cur.kind === 'docker' ? ' cd-ib--dk' : ''}`}><Icon name={cur.kind === 'docker' ? 'box' : 'server'} /></span>
        {cur.kind === 'system' ? `Caddy${cur.version ? ` ${cur.version}` : ''}` : cur.name}
        <small>{where(cur)}</small>
        <span className={`cd-dot${cur.running ? ' is-ok' : ''}`} />
        <Icon name="chevron" size={15} />
      </button>
      {open && (
        <div className="cd-menu" role="menu" aria-label={t('menu.title')}>
          <div className="cd-menu-h">
            {t('menu.title')}
            <span>{tn('menu.found', { n: list.length })}</span>
          </div>
          {list.map((i) => (
            <Item
              key={i.key}
              i={i}
              on={i.key === cur.key}
              onPick={() => {
                chooseInstance(i.key);
                setOpen(false);
              }}
            />
          ))}
          {det.data.dockerSkipped && (
            <div className="cd-menu-f">
              <Button size="sm" icon="unlock" onClick={() => void lookInDocker()}>{t('menu.lookDocker')}</Button>
              <span>{t('menu.lookDockerText')}</span>
            </div>
          )}
          <div className="cd-menu-f">
            <Button size="sm" variant="ghost" icon="refresh" loading={det.loading} onClick={() => void detection.refresh()}>{t('menu.again')}</Button>
            <span>{det.data.docker.present ? t('menu.checked') : t('menu.checkedNoDocker')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
