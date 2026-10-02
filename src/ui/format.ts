import { getSdk } from '../sdk';

const lang = () => (getSdk().lang() === 'it' ? 'it' : 'en');

/** "3 days", "5 hours", "2 minutes" for a duration in ms. */
export function duration(ms: number): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400e3], ['hour', 3600e3], ['minute', 60e3]];
  for (const [u, n] of units) {
    if (ms >= n || u === 'minute') {
      const v = Math.max(1, Math.floor(ms / n));
      return new Intl.NumberFormat(lang(), { style: 'unit', unit: u, unitDisplay: 'long' }).format(v);
    }
  }
  return '';
}

/** "2 hours ago", "yesterday", "in 9 days". */
export function relative(ts: number, now = Date.now()): string {
  const d = ts - now;
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  if (abs < 60e3) return rtf.format(0, 'second');
  if (abs < 3600e3) return rtf.format(Math.round(d / 60e3), 'minute');
  if (abs < 86400e3) return rtf.format(Math.round(d / 3600e3), 'hour');
  return rtf.format(Math.round(d / 86400e3), 'day');
}

export const dateShort = (ts: number) => new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
export const dateTime = (ts: number) => new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts);
export const clock = (ts: number) => new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ts);
export const num = (n: number) => new Intl.NumberFormat(lang()).format(n);
export const daysLeft = (ts: number, now = Date.now()) => Math.floor((ts - now) / 86400e3);
