/** Which tab the page shows, which site is open in the editor, and where the Caddyfile editor should jump. */
import { store } from '../api/store';

export type TabId = 'sites' | 'caddyfile' | 'certs' | 'logs';

export interface Nav {
  tab: TabId;
  /** Sites: the site open in the editor ("file#first address"), or "new". */
  site: string | null;
  /** Caddyfile: open this file at this line (1-based). */
  jump: { file: string; line: number; n: number } | null;
  /** Logs: preset search (an IP, a host). */
  logQuery: string;
}

export const nav = store<Nav>({ tab: 'sites', site: null, jump: null, logQuery: '' });

export const go = (tab: TabId, extra: Partial<Nav> = {}) => nav.set((n) => ({ ...n, tab, ...extra }));

let jumps = 0;
export const openInCaddyfile = (file: string, line: number) => go('caddyfile', { jump: { file, line, n: ++jumps } });

export const siteKey = (s: { file: string; addresses: string[] }) => `${s.file}#${s.addresses[0] ?? ''}`;
