/** Small pieces shared by the views: kind icon, HTTPS state, wire, backend state. */
import type { SiteKind } from '../api/caddyfile';
import { t } from '../i18n';
import { Icon } from '../kit';
import { daysLeft } from './format';
import { KIND_HUE, KIND_ICON } from './icons';

export function KindIcon({ kind, size = 36 }: { kind: SiteKind; size?: number }) {
  return (
    <span className={`cd-ki hue-${KIND_HUE[kind]}`} style={{ width: size, height: size }} title={t(`kind.${kind}`)}>
      <Icon name={KIND_ICON[kind]} />
    </span>
  );
}

export type TlsState = 'ok' | 'warn' | 'renew' | 'int' | 'off' | 'none' | 'expired';

/** How a site's HTTPS looks from its certificate (and the TLS failures in the log). */
export function tlsState(cert: { notBefore: number; notAfter: number; local: boolean } | undefined | null, failing: boolean, hasHttps: boolean, now = Date.now()): { state: TlsState; days: number } {
  if (!hasHttps) return { state: 'off', days: 0 };
  if (!cert) return { state: failing ? 'warn' : 'none', days: 0 };
  const days = daysLeft(cert.notAfter, now);
  if (days < 0) return { state: 'expired', days };
  if (cert.local) return { state: 'int', days };
  if (failing) return { state: 'warn', days };
  const life = cert.notAfter - cert.notBefore;
  if (cert.notAfter - now < life / 3) return { state: 'renew', days };
  return { state: 'ok', days };
}

export function Tls({ state, days }: { state: TlsState; days: number }) {
  const label =
    state === 'off'
      ? t('tls.off')
      : state === 'none'
        ? t('tls.none')
        : state === 'int'
          ? t('tls.local')
          : state === 'expired'
            ? t('tls.expired')
            : state === 'warn'
              ? t('tls.warn', { n: days })
              : state === 'renew'
                ? t('tls.renew', { n: days })
                : t('tls.ok', { n: days });
  return (
    <span className={`cd-tls is-${state}`}>
      <Icon name="lock" size={13} />
      {label}
    </span>
  );
}

export function Wire({ down }: { down?: boolean }) {
  return (
    <span className={`cd-wire${down ? ' is-down' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 100 10" preserveAspectRatio="none">
        <path d="M0 5H100" />
      </svg>
    </span>
  );
}

export function Reach({ up }: { up: boolean | null | undefined }) {
  if (up === undefined || up === null) return null;
  return (
    <span className={`cd-up${up ? '' : ' is-down'}`}>
      <i />
      {up ? t('reach.up') : t('reach.down')}
    </span>
  );
}

export function TargetLabel({ icon, text }: { icon: string; text: string }) {
  return (
    <span className="cd-tgt">
      <Icon name={icon} size={14} />
      <span>{text}</span>
    </span>
  );
}
