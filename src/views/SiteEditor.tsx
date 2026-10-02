import { useEffect, useMemo, useState } from 'react';
import bcrypt from 'bcryptjs';
import { apply } from '../api/actions';
import {
  OFF, addSite, emptyForm, formOf, generateSite, lineMarks, logFileFor, removeSite, replaceSite, setSiteEnabled, type SiteForm,
} from '../api/caddyfile';
import { listContainers } from '../api/docker';
import { run, errorText } from '../api/run';
import { detection, useCurrent, type SiteRef } from '../api/state';
import { resource } from '../api/store';
import { t } from '../i18n';
import { Button, ConfirmDialog, Icon, IconButton, Input, Switch, toast } from '../kit';
import { openInCaddyfile } from '../shell/nav';
import { KIND_ICON } from '../ui/icons';

type Kind = Exclude<SiteForm['kind'], 'custom'>;
const KINDS: Kind[] = ['proxy', 'static', 'php', 'redirect'];

interface Suggestion {
  value: string;
  label: string;
  hint: string;
  icon: string;
}

/** Where a reverse proxy can send traffic: containers Caddy can reach, and ports open on this machine. */
const suggestions = new Map<string, ReturnType<typeof resource<Suggestion[]>>>();
function suggestionsFor(key: string, docker: boolean, networks: string[], dockerOk: boolean) {
  let r = suggestions.get(key);
  if (!r) {
    r = resource(async () => {
      const out: Suggestion[] = [];
      const seen = new Set<string>();
      const add = (s: Suggestion) => {
        if (!seen.has(s.value)) {
          seen.add(s.value);
          out.push(s);
        }
      };
      try {
        for (const c of dockerOk ? await listContainers() : []) {
          if (c.State !== 'running') continue;
          const name = c.Names[0]?.replace(/^\//, '') ?? '';
          if (docker) {
            const nets = Object.keys(c.NetworkSettings?.Networks ?? {});
            if (!nets.some((n) => networks.includes(n))) continue;
            for (const p of c.Ports.filter((p) => p.Type === 'tcp')) add({ value: `${name}:${p.PrivatePort}`, label: name, hint: t('editor.sugContainer', { port: p.PrivatePort }), icon: 'box' });
          } else {
            for (const p of c.Ports.filter((p) => p.Type === 'tcp' && p.PublicPort)) add({ value: `localhost:${p.PublicPort}`, label: name, hint: t('editor.sugPublished', { port: p.PublicPort! }), icon: 'box' });
          }
        }
      } catch {
        /* no Docker, or not allowed */
      }
      if (!docker) {
        try {
          const r = await run('ports');
          for (const l of r.stdout.split('\n')) {
            const m = l.trim().split(/\s+/)[3]?.match(/^(?:\[?([^\]]*)\]?):(\d+)$/);
            if (!m) continue;
            const port = +m[2];
            if ([22, 53, 80, 443, 2019, 25, 631].includes(port)) continue;
            add({ value: `localhost:${port}`, label: `localhost:${port}`, hint: t('editor.sugPort'), icon: 'server' });
          }
        } catch {
          /* ss missing */
        }
      }
      return out;
    });
    suggestions.set(key, r);
  }
  return r;
}

const ADDR = /^(https?:\/\/)?(\*\.)?[A-Za-z0-9.-]*[A-Za-z0-9](:\d{1,5})?$|^:\d{1,5}$/;

function problems(f: SiteForm, wantPassword: string, hadHash: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.addresses.length) e.addresses = t('editor.e.addresses');
  else if (f.addresses.some((a) => !ADDR.test(a))) e.addresses = t('editor.e.address');
  if (f.kind === 'proxy' && !f.target.trim()) e.target = t('editor.e.target');
  if ((f.kind === 'static' || f.kind === 'php') && !f.root.startsWith('/')) e.root = t('editor.e.root');
  if (f.kind === 'php' && !f.target.trim()) e.target = t('editor.e.fpm');
  if (f.kind === 'redirect' && !/^(https?:\/\/|\/)/.test(f.redirectTo)) e.redirect = t('editor.e.redirect');
  if (f.options.auth) {
    if (!/^[A-Za-z0-9._-]+$/.test(f.options.auth.user)) e.user = t('editor.e.user');
    if ((!hadHash || wantPassword) && wantPassword.length < 8) e.password = t('editor.e.password');
  }
  return e;
}

export function SiteEditor({ site, onClose }: { site: SiteRef | null; onClose(): void }) {
  const { inst, data } = useCurrent()!;
  const cfg = data.config.use().data!;
  const presented = data.presented.use().data;
  const [form, setForm] = useState<SiteForm>(() => (site ? formOf(site) : emptyForm()));
  const [addr, setAddr] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [touched, setTouched] = useState(false);
  const det = detection.use().data;
  const sug = suggestionsFor(inst.key, inst.kind === 'docker', inst.container?.networks ?? [], inst.kind === 'docker' || !!det?.docker.direct);
  const sugs = sug.use();
  const [sugOpen, setSugOpen] = useState(false);

  useEffect(() => {
    if (form.kind === 'proxy') void sug.ensure(60_000);
  }, [form.kind]);

  const file = site?.file ?? cfg.main;
  const text = cfg.files[file] ?? '';
  const custom = site?.kind === 'custom';
  const set = (p: Partial<SiteForm>) => {
    setTouched(true);
    setForm((f) => ({ ...f, ...p }));
  };
  const setOpt = (p: Partial<SiteForm['options']>) => {
    setTouched(true);
    setForm((f) => ({ ...f, options: { ...f.options, ...p } }));
  };

  const errs = problems(form, password, !!form.options.auth?.hash);
  const block = useMemo(() => generateSite(form, site ?? undefined), [form, site]);
  const original = site ? text.split('\n').slice(site.start, site.end + 1).map((l) => (l.startsWith(OFF) ? l.slice(OFF.length) : l)).join('\n') : '';
  const marks = useMemo(() => lineMarks(original, block), [original, block]);
  const changed = !site || marks.some(Boolean) || original.split('\n').length !== block.split('\n').length;

  const name = site?.addresses[0]?.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const cert = name ? presented?.[name] : undefined;
  const certDays = cert ? Math.floor((cert.notAfter - Date.now()) / 86400e3) : null;

  const commit = async (next: string, what: 'save' | 'off' | 'on' | 'delete') => {
    setBusy(what);
    setError('');
    try {
      const r = await apply(inst, cfg, { [file]: next });
      if (r.ok) {
        toast.ok(t(`editor.done.${what}`), r.notRunning ? t('editor.notRunning') : t('shell.reloadedText'));
        onClose();
      } else {
        setError(t(`editor.fail.${r.stage}`, { output: r.output }));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (Object.keys(errs).length) {
      setTouched(true);
      return;
    }
    let f = form;
    if (f.options.auth && password) {
      setBusy('save');
      const hash = await bcrypt.hash(password, 12);
      f = { ...f, options: { ...f.options, auth: { user: f.options.auth.user, hash } } };
    }
    if (f.options.accessLog && !f.options.logFile) f = { ...f, options: { ...f.options, logFile: logFileFor(f.addresses) } };
    const b = generateSite(f, site ?? undefined);
    await commit(site ? replaceSite(text, site, b) : addSite(text, b), 'save');
  };

  const addAddress = () => {
    const v = addr.trim().replace(/,$/, '');
    if (v && !form.addresses.includes(v)) set({ addresses: [...form.addresses, v] });
    setAddr('');
  };

  const show = (k: string) => (touched || k === 'addresses' ? errs[k] : undefined);

  return (
    <aside className="cd-ed" aria-label={site ? t('editor.aria', { name: site.addresses[0] }) : t('editor.newTitle')}>
      <div className="cd-edh">
        <span className={`cd-lk2${cert && certDays !== null && certDays < 14 && !cert.local ? ' is-warn' : ''}`}><Icon name={site ? 'lock' : 'plus'} /></span>
        <div>
          <b>{site ? site.addresses[0] : t('editor.newTitle')}</b>
          <span>{site ? t('editor.where', { kind: t(`kind.${site.kind}`), file: file.split('/').pop()!, line: site.start + 1 }) : t('editor.newText')}</span>
        </div>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </div>

      {cert && certDays !== null && certDays < 14 && !cert.local && (
        <div className="cd-note is-warn"><Icon name="clock" size={17} /><span>{t('editor.certSoon', { issuer: cert.issuer, n: certDays })}</span></div>
      )}
      {site?.disabled && <div className="cd-note"><Icon name="eyeoff" size={17} /><span>{t('editor.isOff')}</span></div>}
      {custom && (
        <div className="cd-note is-info"><Icon name="info" size={17} /><span>{t('editor.custom')}</span></div>
      )}
      {site && !site.editable && (
        <div className="cd-note is-info"><Icon name="info" size={17} /><span>{t('editor.oneLine')}</span></div>
      )}

      {!custom && (
        <div className="cd-ktabs" role="radiogroup" aria-label={t('editor.kind')}>
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={form.kind === k ? 'is-on' : ''} onClick={() => set({ kind: k, target: k === form.kind ? form.target : k === 'php' ? 'unix//run/php-fpm/php-fpm.sock' : k === 'proxy' ? '' : form.target })}>
              <Icon name={KIND_ICON[k]} size={18} />
              {t(`kind.${k}`)}
            </button>
          ))}
        </div>
      )}

      <div className="cd-fl">
        <label htmlFor="cd-addr">{t('editor.addresses')}</label>
        <div className={`cd-tags${show('addresses') ? ' is-bad' : ''}`}>
          {form.addresses.map((a) => (
            <span key={a} className="cd-tag">
              {a}
              <button type="button" aria-label={t('editor.removeAddr', { name: a })} onClick={() => set({ addresses: form.addresses.filter((x) => x !== a) })}><Icon name="close" size={13} /></button>
            </span>
          ))}
          <input
            id="cd-addr"
            value={addr}
            placeholder={form.addresses.length ? t('editor.addAnother') : 'app.example.com'}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                e.preventDefault();
                addAddress();
              } else if (e.key === 'Backspace' && !addr && form.addresses.length) set({ addresses: form.addresses.slice(0, -1) });
            }}
            onBlur={addAddress}
          />
        </div>
        <span className={`cd-hint${show('addresses') ? ' is-bad' : ''}`}>{show('addresses') && form.addresses.length ? errs.addresses : t('editor.addressesHint')}</span>
      </div>

      {form.kind === 'proxy' && (
        <div className="cd-fl cd-combo">
          <Input
            label={t('editor.target')}
            icon={inst.kind === 'docker' ? 'box' : 'server'}
            mono
            value={form.target}
            placeholder={inst.kind === 'docker' ? 'app:8080' : 'localhost:8080'}
            error={show('target')}
            hint={!show('target') ? t(inst.kind === 'docker' ? 'editor.targetHintDocker' : 'editor.targetHint') : undefined}
            onChange={(e) => set({ target: e.target.value })}
            onFocus={() => setSugOpen(true)}
            onBlur={() => setTimeout(() => setSugOpen(false), 150)}
            aria-autocomplete="list"
          />
          {sugOpen && !!sugs.data?.length && (
            <div className="cd-sug" role="listbox">
              {sugs.data
                .filter((s) => !form.target || s.value.includes(form.target) || s.label.includes(form.target))
                .slice(0, 8)
                .map((s) => (
                  <button key={s.value} type="button" role="option" aria-selected={s.value === form.target} onMouseDown={(e) => e.preventDefault()} onClick={() => { set({ target: s.value }); setSugOpen(false); }}>
                    <Icon name={s.icon} size={15} />
                    <b>{s.label}</b>
                    <span>{s.hint}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {(form.kind === 'static' || form.kind === 'php') && (
        <Input label={t('editor.root')} icon="folder" mono value={form.root} error={show('root')} hint={!show('root') ? t('editor.rootHint') : undefined} onChange={(e) => set({ root: e.target.value })} />
      )}
      {form.kind === 'php' && (
        <Input label={t('editor.fpm')} mono value={form.target} error={show('target')} hint={!show('target') ? t('editor.fpmHint') : undefined} onChange={(e) => set({ target: e.target.value })} />
      )}
      {form.kind === 'static' && <Switch checked={form.browse} onChange={(v) => set({ browse: v })} label={t('editor.browse')} />}
      {form.kind === 'redirect' && (
        <>
          <Input label={t('editor.redirectTo')} icon="globe" mono value={form.redirectTo} placeholder="https://example.com{uri}" error={show('redirect')} hint={!show('redirect') ? t('editor.redirectHint') : undefined} onChange={(e) => set({ redirectTo: e.target.value })} />
          <Switch checked={form.permanent} onChange={(v) => set({ permanent: v })} label={t('editor.permanent')} />
        </>
      )}

      <div className="cd-opts">
        <Opt on={form.options.compress} title={t('editor.o.compress')} sub={t('editor.o.compressSub')} onChange={(v) => setOpt({ compress: v })} />
        <Opt on={form.options.securityHeaders} title={t('editor.o.headers')} sub={t('editor.o.headersSub')} onChange={(v) => setOpt({ securityHeaders: v })} />
        <Opt on={form.options.accessLog} title={t('editor.o.log')} sub={form.options.logFile || logFileFor(form.addresses)} onChange={(v) => setOpt({ accessLog: v, logFile: v ? form.options.logFile || logFileFor(form.addresses) : '' })} />
        <Opt on={!!form.options.auth} title={t('editor.o.auth')} sub={t('editor.o.authSub')} onChange={(v) => setOpt({ auth: v ? site?.options.auth ?? { user: 'admin', hash: '' } : null })} />
      </div>
      {form.options.auth && (
        <div className="cd-row2">
          <Input label={t('editor.user')} value={form.options.auth.user} error={show('user')} onChange={(e) => setOpt({ auth: { ...form.options.auth!, user: e.target.value } })} />
          <Input
            label={t('editor.password')}
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={site?.options.auth?.hash ? t('editor.passwordKeep') : ''}
            error={show('password')}
            onChange={(e) => {
              setTouched(true);
              setPassword(e.target.value);
            }}
          />
        </div>
      )}

      <div className="cd-gen">
        <div className="cd-genh">
          <Icon name="code" size={14} />
          {t('editor.preview')}
          <span>{site ? (changed ? t('editor.previewChanged') : t('editor.previewSame')) : t('editor.previewNew')}</span>
        </div>
        <pre>
          {block.split('\n').map((l, i) => (
            <span key={i} className={site ? (marks[i] === 'add' ? 'is-add' : marks[i] === 'chg' ? 'is-chg' : '') : 'is-add'}>{l || ' '}{'\n'}</span>
          ))}
        </pre>
        {site && (
          <button type="button" className="cd-linkbtn" onClick={() => openInCaddyfile(file, site.start + 1)}>{t('editor.openInFile')}</button>
        )}
      </div>

      {error && <div className="cd-note is-err" role="alert"><Icon name="alert" size={17} /><span className="cd-pre">{error}</span></div>}

      <div className="cd-eda">
        {site && (
          <>
            <Button variant="ghost" icon={site.disabled ? 'eye' : 'eyeoff'} loading={busy === 'off' || busy === 'on'} disabled={!!busy} onClick={() => void commit(setSiteEnabled(text, site, site.disabled), site.disabled ? 'on' : 'off')}>
              {site.disabled ? t('editor.turnOn') : t('editor.turnOff')}
            </Button>
            <Button variant="ghost" className="cd-danger" icon="trash" disabled={!!busy} onClick={() => setConfirmDelete(true)}>{t('editor.delete')}</Button>
          </>
        )}
        <span className="cd-sp" />
        <Button onClick={onClose} disabled={!!busy}>{t('common.cancel')}</Button>
        <Button variant="primary" icon="check" loading={busy === 'save'} disabled={!!busy || (!!site && !changed && !password) || (!!site && !site.editable)} onClick={() => void save()}>
          {t('editor.save')}
        </Button>
      </div>

      {site && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => commit(removeSite(text, site), 'delete')}
          title={t('editor.deleteTitle', { name: site.addresses[0] })}
          description={t('editor.deleteText')}
          confirmLabel={t('editor.delete')}
          danger
          icon="trash"
        />
      )}
    </aside>
  );
}

function Opt({ on, title, sub, onChange }: { on: boolean; title: string; sub: string; onChange(v: boolean): void }) {
  return (
    <label className="cd-op">
      <Switch checked={on} onChange={onChange} aria-label={title} />
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </label>
  );
}
