/**
 * Caddyfile reading and writing, by lines, so that a change touches only the lines it must: comments, blank lines
 * and the formatting of every other block stay as the user wrote them.
 *
 *   const doc = parse(text);                 // top-level blocks with their line ranges
 *   const site = doc.sites[0];               // addresses, kind, target, options, extra lines
 *   const next = replaceSite(text, site, generateSite(model));   // or addSite / removeSite / setSiteEnabled
 *
 * A site turned off in Ervisio stays in the file as comments starting with OFF ("#ervisio:off "), so it can come
 * back exactly as it was.
 */

export const OFF = '#ervisio:off ';

/* ---------- tokens ---------- */

export interface Token {
  text: string;
  /** 0-based line where the token starts / ends (quoted strings and heredocs can span lines). */
  line: number;
  endLine: number;
  quoted: boolean;
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const start = line;
    if (c === '"' || c === '`') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (c === '"' && src[j] === '\\' && j + 1 < n) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') line++;
        s += src[j++];
      }
      out.push({ text: s, line: start, endLine: line, quoted: true });
      i = j + 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && /[A-Za-z]/.test(src[i + 2] ?? '')) {
      // heredoc: <<MARKER ... MARKER
      let j = i + 2;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const marker = src.slice(i + 2, j);
      const endRe = new RegExp(`^[ \\t]*${marker}[ \\t]*$`);
      let k = src.indexOf('\n', j);
      let body = '';
      while (k >= 0 && k < n) {
        line++;
        const e = src.indexOf('\n', k + 1);
        const l = src.slice(k + 1, e < 0 ? n : e);
        if (endRe.test(l)) {
          k = e < 0 ? n : e;
          break;
        }
        body += (body ? '\n' : '') + l;
        k = e < 0 ? n : e;
      }
      out.push({ text: body, line: start, endLine: line, quoted: true });
      i = k < 0 ? n : k;
      continue;
    }
    let j = i;
    while (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n') j++;
    out.push({ text: src.slice(i, j), line, endLine: line, quoted: false });
    i = j;
  }
  return out;
}

/* ---------- tree ---------- */

export interface Node {
  name: string;
  args: string[];
  /** 0-based first and last line (the closing brace for a block). */
  line: number;
  endLine: number;
  block: boolean;
  /** The opening brace is on the same line as the closing one or as a child (one-liner). */
  inline: boolean;
  children: Node[];
}

const isOpen = (t: Token) => !t.quoted && t.text === '{';
const isClose = (t: Token) => !t.quoted && t.text === '}';

export function parseNodes(tokens: Token[]): Node[] {
  let i = 0;
  const nodes = (inBlock: boolean): { list: Node[]; close?: number } => {
    const list: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (isClose(t)) {
        i++;
        if (inBlock) return { list, close: t.line };
        continue;
      }
      const head: Token[] = [];
      let node: Node | undefined;
      while (i < tokens.length) {
        const k = tokens[i];
        if (head.length && k.line !== head[head.length - 1].endLine) break;
        if (isClose(k)) break;
        if (isOpen(k)) {
          i++;
          const openLine = k.line;
          const inner = nodes(true);
          const first = head[0] ?? k;
          const endLine = inner.close ?? tokens[tokens.length - 1]?.endLine ?? openLine;
          node = {
            name: head[0]?.text ?? '{',
            args: head.slice(1).map((x) => x.text),
            line: first.line,
            endLine,
            block: true,
            inline: inner.list.some((c) => c.line === openLine) || endLine === openLine,
            children: inner.list,
          };
          break;
        }
        head.push(k);
        i++;
      }
      if (!node && head.length) {
        node = { name: head[0].text, args: head.slice(1).map((x) => x.text), line: head[0].line, endLine: head[head.length - 1].endLine, block: false, inline: false, children: [] };
      }
      if (node) list.push(node);
    }
    return { list };
  };
  return nodes(false).list;
}

/* ---------- document ---------- */

export type BlockKind = 'global' | 'snippet' | 'site' | 'import' | 'other';

export interface Block {
  kind: BlockKind;
  node: Node;
  start: number;
  end: number;
  disabled: boolean;
}

export type SiteKind = 'proxy' | 'static' | 'php' | 'redirect' | 'custom';

export interface SiteOptions {
  compress: boolean;
  securityHeaders: boolean;
  accessLog: boolean;
  /** `output file <path>` of the log directive, when it writes to a file. */
  logFile: string;
  /** Basic auth: one user and its bcrypt hash. */
  auth: { user: string; hash: string } | null;
}

export interface Site {
  addresses: string[];
  kind: SiteKind;
  /** proxy: upstreams ("app:8080", several separated by spaces); php: PHP-FPM address. */
  target: string;
  /** static and php: the folder served. */
  root: string;
  browse: boolean;
  /** redirect: where to; `keepPath` = the target ends with {uri}. */
  redirectTo: string;
  permanent: boolean;
  options: SiteOptions;
  /** Directives the form does not know, kept as they are (one string per directive, with its own lines). */
  extra: string[];
  /** Whether every line of the block can be rewritten by the form (false for one-line blocks). */
  editable: boolean;
  start: number;
  end: number;
  disabled: boolean;
  /** Raw text of recognised directives, reused when the form leaves them unchanged. */
  raw: Partial<Record<'proxy' | 'php' | 'root' | 'files' | 'redir' | 'encode' | 'header' | 'log' | 'auth', string>>;
}

export interface Doc {
  lines: string[];
  blocks: Block[];
  sites: Site[];
  snippets: string[];
  imports: string[];
}

export const SECURITY_HEADERS: [string, string][] = [
  ['Strict-Transport-Security', '"max-age=31536000"'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
];

function classifyNode(n: Node): BlockKind {
  if (n.name === '{' && n.block) return 'global';
  if (/^\(.+\)$/.test(n.name)) return 'snippet';
  if (n.name === 'import' && !n.block) return 'import';
  if (n.block) return 'site';
  return 'other';
}

export function parse(text: string): Doc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  for (const node of parseNodes(tokenize(text))) {
    blocks.push({ kind: classifyNode(node), node, start: node.line, end: node.endLine, disabled: false });
  }
  // Sites turned off: runs of lines starting with OFF, parsed on their own.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(OFF.trimEnd())) continue;
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].startsWith(OFF.trimEnd())) j++;
    const inner = lines.slice(i, j + 1).map((l) => l.slice(l.startsWith(OFF) ? OFF.length : OFF.trimEnd().length)).join('\n');
    for (const node of parseNodes(tokenize(inner))) {
      if (classifyNode(node) !== 'site') continue;
      const shift = (x: Node): Node => ({ ...x, line: x.line + i, endLine: x.endLine + i, children: x.children.map(shift) });
      const s = shift(node);
      blocks.push({ kind: 'site', node: s, start: s.line, end: s.endLine, disabled: true });
    }
    i = j;
  }
  blocks.sort((a, b) => a.start - b.start);
  const view = (b: Block) => (b.disabled ? lines.map((l) => (l.startsWith(OFF) ? l.slice(OFF.length) : l.startsWith(OFF.trimEnd()) ? l.slice(OFF.trimEnd().length) : l)) : lines);
  return {
    lines,
    blocks,
    sites: blocks.filter((b) => b.kind === 'site').map((b) => siteFrom(b, view(b))),
    snippets: blocks.filter((b) => b.kind === 'snippet').map((b) => b.node.name.slice(1, -1)),
    imports: blocks.filter((b) => b.kind === 'import').map((b) => b.node.args[0]).filter(Boolean),
  };
}

/** The addresses of a site header: "a.com, b.com" or "a.com b.com". */
export function splitAddresses(head: string[]): string[] {
  return head
    .join(' ')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The lines of a child directive, dedented so that its first line starts at column 0. */
function rawOf(n: Node, lines: string[]): string {
  const part = lines.slice(n.line, n.endLine + 1);
  const ind = (part[0].match(/^[\t ]*/) ?? [''])[0];
  return part.map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l.replace(/^[\t ]+/, ''))).join('\n');
}

function headersAreOurs(n: Node): boolean {
  if (!n.block || n.args.length) return false;
  const want = new Map(SECURITY_HEADERS.map(([k]) => [k.toLowerCase(), true]));
  if (n.children.length !== SECURITY_HEADERS.length) return false;
  return n.children.every((c) => want.has(c.name.toLowerCase()) && !c.block);
}

function siteFrom(b: Block, lines: string[]): Site {
  const n = b.node;
  const s: Site = {
    addresses: splitAddresses([n.name, ...n.args]),
    kind: 'custom',
    target: '',
    root: '',
    browse: false,
    redirectTo: '',
    permanent: true,
    options: { compress: false, securityHeaders: false, accessLog: false, logFile: '', auth: null },
    extra: [],
    editable: !n.inline && n.children.every((c) => !c.inline || !c.block),
    start: b.start,
    end: b.end,
    disabled: b.disabled,
    raw: {},
  };
  let proxy = false;
  let php = false;
  let files = false;
  let redir: Node | undefined;
  const handlers = new Set(['reverse_proxy', 'php_fastcgi', 'file_server', 'redir', 'respond', 'handle', 'handle_path', 'route', 'static_response']);
  const mainHandlers = n.children.filter((c) => handlers.has(c.name));
  for (const c of n.children) {
    const raw = rawOf(c, lines);
    const matcher = c.args[0] && (c.args[0].startsWith('@') || c.args[0].startsWith('/'));
    switch (c.name) {
      case 'reverse_proxy':
        if (!proxy && !matcher && c.args.length) {
          proxy = true;
          s.target = c.args.join(' ');
          s.raw.proxy = raw;
          continue;
        }
        break;
      case 'php_fastcgi':
        if (!php && !matcher && c.args.length) {
          php = true;
          s.target = c.args.join(' ');
          s.raw.php = raw;
          continue;
        }
        break;
      case 'root':
        if (!c.block && !s.root && (c.args.length === 1 || (c.args.length === 2 && c.args[0] === '*'))) {
          s.root = c.args[c.args.length - 1];
          s.raw.root = raw;
          continue;
        }
        break;
      case 'file_server':
        if (!files && !c.block && !matcher && (c.args.length === 0 || (c.args.length === 1 && c.args[0] === 'browse'))) {
          files = true;
          s.browse = c.args[0] === 'browse';
          s.raw.files = raw;
          continue;
        }
        break;
      case 'redir':
        if (!redir && !c.block && !matcher && c.args.length >= 1 && c.args.length <= 2 && mainHandlers.length === 1) {
          redir = c;
          s.redirectTo = c.args[0];
          s.permanent = !c.args[1] || ['permanent', '301', '308'].includes(c.args[1]);
          s.raw.redir = raw;
          continue;
        }
        break;
      case 'encode':
        if (!s.options.compress && !matcher) {
          s.options.compress = true;
          s.raw.encode = raw;
          continue;
        }
        break;
      case 'header':
        if (!s.options.securityHeaders && headersAreOurs(c)) {
          s.options.securityHeaders = true;
          s.raw.header = raw;
          continue;
        }
        break;
      case 'log':
        if (!s.options.accessLog && !c.args.length) {
          s.options.accessLog = true;
          const out = c.children.find((x) => x.name === 'output');
          if (out?.args[0] === 'file' && out.args[1]) s.options.logFile = out.args[1];
          if (c.children.every((x) => x.name === 'output' && !x.block && x.args[0] === 'file' && x.args.length === 2)) {
            s.raw.log = raw;
            continue;
          }
          s.raw.log = raw;
          continue;
        }
        break;
      case 'basic_auth':
      case 'basicauth':
        if (!s.options.auth && !c.args.length && c.children.length === 1 && c.children[0].args.length === 1 && !c.children[0].block) {
          s.options.auth = { user: c.children[0].name, hash: c.children[0].args[0] };
          s.raw.auth = raw;
          continue;
        }
        break;
    }
    s.extra.push(raw);
  }
  if (proxy) s.kind = 'proxy';
  else if (php) s.kind = 'php';
  else if (files) s.kind = 'static';
  else if (redir) s.kind = 'redirect';
  // A root or a file_server that is not the site's own handler belongs to whatever else the block does.
  const k = s.kind as SiteKind;
  if (s.raw.root && k !== 'static' && k !== 'php') {
    s.extra.unshift(s.raw.root);
    delete s.raw.root;
  }
  if (s.raw.files && k !== 'static' && k !== 'php') {
    s.extra.push(s.raw.files);
    delete s.raw.files;
  }
  if (s.kind === 'php' && s.raw.files) delete s.raw.files; // php sites usually carry file_server: regenerated
  return s;
}

/* ---------- writing ---------- */

/** What the form edits. */
export interface SiteForm {
  addresses: string[];
  kind: Exclude<SiteKind, 'custom'> | 'custom';
  target: string;
  root: string;
  browse: boolean;
  redirectTo: string;
  permanent: boolean;
  options: SiteOptions;
}

export const formOf = (s: Site): SiteForm => ({
  addresses: [...s.addresses],
  kind: s.kind,
  target: s.target,
  root: s.root,
  browse: s.browse,
  redirectTo: s.redirectTo,
  permanent: s.permanent,
  options: { ...s.options, auth: s.options.auth ? { ...s.options.auth } : null },
});

export const emptyForm = (): SiteForm => ({
  addresses: [],
  kind: 'proxy',
  target: '',
  root: '/srv/www',
  browse: false,
  redirectTo: '',
  permanent: true,
  options: { compress: true, securityHeaders: false, accessLog: false, logFile: '', auth: null },
});

const indent = (raw: string, tab = '\t') => raw.split('\n').map((l) => (l ? tab + l : l)).join('\n');

/** Replaces the arguments of a directive's first line, keeping its block. */
function withArgs(raw: string, name: string, args: string): string {
  const [first, ...rest] = raw.split('\n');
  const open = /\{\s*$/.test(first) ? ' {' : '';
  return [`${name} ${args}${open}`, ...rest].join('\n');
}

export function logFileFor(addresses: string[]): string {
  const host = (addresses[0] ?? 'site').replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'site';
  return `/var/log/caddy/${host}.log`;
}

/** The text of a site block for `form`; `prev` is the site it replaces (its unchanged parts are reused). */
export function generateSite(form: SiteForm, prev?: Site): string {
  const out: string[] = [];
  const same = <K extends keyof SiteForm>(k: K) => prev && JSON.stringify(prev[k as keyof Site]) === JSON.stringify(form[k]);
  const a = form.options.auth;
  if (a) {
    out.push(prev?.raw.auth && prev.options.auth && prev.options.auth.user === a.user && prev.options.auth.hash === a.hash ? prev.raw.auth : `basic_auth {\n\t${a.user} ${a.hash}\n}`);
  }
  switch (form.kind) {
    case 'proxy':
      out.push(prev?.raw.proxy ? (same('target') ? prev.raw.proxy : withArgs(prev.raw.proxy, 'reverse_proxy', form.target)) : `reverse_proxy ${form.target}`);
      break;
    case 'static':
      out.push(prev?.raw.root && same('root') ? prev.raw.root : `root * ${form.root}`);
      out.push(form.browse ? 'file_server browse' : 'file_server');
      break;
    case 'php':
      out.push(prev?.raw.root && same('root') ? prev.raw.root : `root * ${form.root}`);
      out.push(prev?.raw.php ? (same('target') ? prev.raw.php : withArgs(prev.raw.php, 'php_fastcgi', form.target)) : `php_fastcgi ${form.target}`);
      out.push('file_server');
      break;
    case 'redirect':
      out.push(`redir ${form.redirectTo}${form.permanent ? ' permanent' : ''}`);
      break;
    case 'custom':
      break;
  }
  if (form.options.compress) out.push(prev?.raw.encode ?? 'encode zstd gzip');
  if (form.options.securityHeaders) out.push(prev?.raw.header ?? `header {\n${SECURITY_HEADERS.map(([k, v]) => `\t${k} ${v}`).join('\n')}\n}`);
  if (form.options.accessLog) {
    const file = form.options.logFile;
    const keep = prev?.raw.log && prev.options.accessLog && prev.options.logFile === file;
    out.push(keep ? prev!.raw.log! : file ? `log {\n\toutput file ${file}\n}` : 'log');
  }
  out.push(...(prev?.extra ?? []));
  return `${form.addresses.join(', ')} {\n${out.map((x) => indent(x)).join('\n')}\n}`;
}

/** Replaces the lines of `site` with `block` (a site turned off stays off). */
export function replaceSite(text: string, site: Site, block: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const body = site.disabled ? block.split('\n').map((l) => OFF + l) : block.split('\n');
  lines.splice(site.start, site.end - site.start + 1, ...body);
  return lines.join('\n');
}

export function addSite(text: string, block: string): string {
  const t = text.replace(/\s+$/, '');
  return `${t}${t ? '\n\n' : ''}${block}\n`;
}

export function removeSite(text: string, site: Site): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = site.end;
  // Take one blank line with it, and a blank line before when it was the last block.
  if (lines[end + 1]?.trim() === '') end++;
  let start = site.start;
  if (end === lines.length - 1 && start > 0 && lines[start - 1].trim() === '') start--;
  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

export function setSiteEnabled(text: string, site: Site, enabled: boolean): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = site.start; i <= site.end; i++) {
    if (enabled) {
      if (lines[i].startsWith(OFF)) lines[i] = lines[i].slice(OFF.length);
      else if (lines[i].startsWith(OFF.trimEnd())) lines[i] = lines[i].slice(OFF.trimEnd().length);
    } else lines[i] = lines[i] === '' ? OFF.trimEnd() : OFF + lines[i];
  }
  return lines.join('\n');
}

/* ---------- formatting ---------- */

/** Like `caddy fmt`: tabs by nesting, one blank line at most, no trailing spaces. Quoted strings are left alone. */
export function format(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tokens = tokenize(text);
  const opens = new Array(lines.length).fill(0);
  const closesFirst = new Array(lines.length).fill(false);
  const closes = new Array(lines.length).fill(0);
  const inside = new Array(lines.length).fill(false);
  const firstTok = new Array(lines.length).fill(-1);
  tokens.forEach((t, k) => {
    if (firstTok[t.line] < 0) firstTok[t.line] = k;
    for (let l = t.line + 1; l <= t.endLine; l++) inside[l] = true;
    if (isOpen(t)) opens[t.line]++;
    if (isClose(t)) {
      closes[t.line]++;
      if (firstTok[t.line] === k) closesFirst[t.line] = true;
    }
  });
  const out: string[] = [];
  let depth = 0;
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inside[i]) {
      out.push(lines[i]);
      continue;
    }
    const tl = lines[i].trim();
    if (!tl) {
      if (++blank <= 1 && out.length) out.push('');
      continue;
    }
    blank = 0;
    const d = Math.max(0, closesFirst[i] ? depth - 1 : depth);
    out.push('\t'.repeat(d) + tl.replace(/\s+$/, ''));
    depth = Math.max(0, depth + opens[i] - closes[i]);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/* ---------- diff ---------- */

export type DiffOp = { t: '=' | '+' | '-'; line: string; a?: number; b?: number };

/** Line diff (LCS on the part between the common head and tail). */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ t: '=', line: a[i], a: i, b: i });
  if (A.length * B.length > 4_000_000) {
    A.forEach((l, i) => ops.push({ t: '-', line: l, a: head + i }));
    B.forEach((l, i) => ops.push({ t: '+', line: l, b: head + i }));
  } else {
    const m = A.length;
    const n = B.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--) dp[i * (n + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && A[i] === B[j]) {
        ops.push({ t: '=', line: A[i], a: head + i, b: head + j });
        i++;
        j++;
      } else if (j < n && (i >= m || dp[i * (n + 1) + j + 1] > dp[(i + 1) * (n + 1) + j])) {
        ops.push({ t: '+', line: B[j], b: head + j });
        j++;
      } else {
        ops.push({ t: '-', line: A[i], a: head + i });
        i++;
      }
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ t: '=', line: a[a.length - tail + k], a: a.length - tail + k, b: b.length - tail + k });
  return ops;
}

/** For each line of `b`: 'add' (new), 'chg' (replaces a removed line) or ''. */
export function lineMarks(a: string, b: string): ('add' | 'chg' | '')[] {
  const bl = b.split('\n');
  const marks: ('add' | 'chg' | '')[] = new Array(bl.length).fill('');
  const ops = diffLines(a.split('\n'), bl);
  let removed = 0;
  for (const op of ops) {
    if (op.t === '-') removed++;
    else if (op.t === '+') {
      marks[op.b!] = removed > 0 ? 'chg' : 'add';
      if (removed > 0) removed--;
    } else removed = 0;
  }
  return marks;
}

export function changedCount(a: string, b: string): number {
  return diffLines(a.split('\n'), b.split('\n')).filter((o) => o.t !== '=').length;
}

/* ---------- imports ---------- */

function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

/** The files of `all` that the main Caddyfile imports (relative paths resolve against its folder). */
export function importedFiles(doc: Doc, mainPath: string, all: string[]): string[] {
  const dir = mainPath.slice(0, mainPath.lastIndexOf('/'));
  const out = new Set<string>();
  for (const imp of doc.imports) {
    if (doc.snippets.includes(imp)) continue;
    const abs = imp.startsWith('/') ? imp : `${dir}/${imp}`;
    const re = globToRe(abs.replace(/\/\.\//g, '/'));
    for (const f of all) if (f !== mainPath && re.test(f)) out.add(f);
  }
  return [...out].sort();
}

/* ---------- reading helpers ---------- */

/** Host and port of an upstream such as "app:8080", "http://app:8080", "localhost:3000" (null for sockets etc.). */
export function upstreamURL(target: string): string | null {
  const first = target.trim().split(/\s+/)[0] ?? '';
  if (!first || first.includes('{') || first.startsWith('unix/') || first.startsWith('srv+')) return null;
  const m = first.match(/^(?:(https?|h2c):\/\/)?([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/);
  if (!m) return null;
  const scheme = m[1] === 'https' ? 'https' : 'http';
  const port = m[3] ?? (scheme === 'https' ? '443' : '80');
  if (m[2].startsWith('[')) return null;
  return `${scheme}://${m[2]}:${port}`;
}

/** The domain names of a site's addresses that can get a public certificate. */
export function publicNames(addresses: string[]): string[] {
  return addresses
    .map((a) => a.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, ''))
    .filter((h) => /^[A-Za-z0-9*.-]+\.[A-Za-z]{2,}$/.test(h) && !/\.(local|lan|internal|home|test|localhost)$/i.test(h) && h !== 'localhost');
}

/** Short summary of what changed between two versions, for the history ("Added x", "Changed y"...). */
export function summarize(before: string, after: string): { added: string[]; removed: string[]; changed: string[]; off: string[]; on: string[] } {
  const key = (s: Site) => s.addresses.join(', ');
  const a = new Map(parse(before).sites.map((s) => [key(s), s]));
  const b = new Map(parse(after).sites.map((s) => [key(s), s]));
  const bl = before.split('\n');
  const al = after.split('\n');
  const body = (s: Site, l: string[]) => l.slice(s.start, s.end + 1).join('\n');
  const r = { added: [] as string[], removed: [] as string[], changed: [] as string[], off: [] as string[], on: [] as string[] };
  for (const [k, s] of b) {
    const p = a.get(k);
    if (!p) r.added.push(s.addresses[0]);
    else if (p.disabled !== s.disabled) (s.disabled ? r.off : r.on).push(s.addresses[0]);
    else if (body(p, bl) !== body(s, al)) r.changed.push(s.addresses[0]);
  }
  for (const [k, s] of a) if (!b.has(k)) r.removed.push(s.addresses[0]);
  return r;
}
