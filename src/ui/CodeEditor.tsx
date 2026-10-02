/**
 * A plain-text editor with Caddyfile colours: a transparent <textarea> laid over a highlighted <pre> in the same
 * grid cell, so both always have the same size. Line numbers on the left; lines can carry a mark (added, changed,
 * error). Tab inserts a tab, Enter keeps the indentation (one more after a line ending in "{").
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

export type LineMark = 'add' | 'chg' | 'err' | '';

const DIRECTIVE = /^(\s*)(\S+)(.*)$/;

function colourRest(rest: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*"?|`[^`]*`?|\{[$A-Za-z_.][^}\s]*\}|(?<=\s)@[A-Za-z0-9_-]+|(?<=\s)\*(?=\s|$)|\s#.*$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(rest))) {
    if (m.index > last) out.push(rest.slice(last, m.index));
    const tok = m[0];
    const cls = tok.trimStart().startsWith('#') ? 'cm' : tok.startsWith('"') || tok.startsWith('`') ? 'st' : tok.startsWith('{') ? 'ph' : 'mt';
    out.push(<span key={`${key}-${k++}`} className={`cd-h-${cls}`}>{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < rest.length) out.push(rest.slice(last));
  return out;
}

/** Colours one line; `depth` is the nesting at its start (0 = top level). */
function highlight(line: string, depth: number, key: string): ReactNode {
  const tl = line.trim();
  if (!tl) return ' ';
  if (tl.startsWith('#')) return <span className="cd-h-cm">{line}</span>;
  const m = line.match(DIRECTIVE)!;
  const [, ind, head, rest] = m;
  if (head === '}' || head === '{') return line;
  const cls = depth === 0 ? (head.startsWith('(') ? 'sn' : head === 'import' ? 'dv' : 'ad') : 'dv';
  if (depth === 0 && cls === 'ad') {
    // the whole header is addresses
    const brace = rest.match(/\s*\{\s*$/);
    const body = brace ? rest.slice(0, rest.length - brace[0].length) : rest;
    return (
      <>
        {ind}
        <span className="cd-h-ad">{head + body}</span>
        {brace ? brace[0] : ''}
      </>
    );
  }
  return (
    <>
      {ind}
      <span className={`cd-h-${cls}`}>{head}</span>
      {colourRest(rest, key)}
    </>
  );
}

/** Nesting depth at the start of each line (braces inside quotes and placeholders do not count). */
function depths(lines: string[]): number[] {
  const out: number[] = [];
  let d = 0;
  for (const l of lines) {
    const toks = l.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""').split(/\s+/).filter(Boolean);
    const startsClose = toks[0] === '}';
    out.push(Math.max(0, startsClose ? d - 1 : d));
    for (const tk of toks) {
      if (tk.startsWith('#')) break;
      if (tk === '{') d++;
      else if (tk === '}') d = Math.max(0, d - 1);
    }
  }
  return out;
}

export interface CodeEditorProps {
  value: string;
  onChange?(v: string): void;
  marks?: LineMark[];
  readOnly?: boolean;
  /** Scroll to this 1-based line and put the cursor there; change `n` to jump again to the same line. */
  jump?: { line: number; n: number } | null;
  onCursor?(line: number, col: number): void;
  label: string;
}

const LH = 21;

export function CodeEditor({ value, onChange, marks, readOnly, jump, onCursor, label }: CodeEditorProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split('\n'), [value]);
  const ds = useMemo(() => depths(lines), [lines]);

  useLayoutEffect(() => {
    if (!jump || !ta.current || !box.current) return;
    const i = Math.max(0, Math.min(lines.length - 1, jump.line - 1));
    const pos = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0);
    box.current.scrollTop = Math.max(0, i * LH - box.current.clientHeight / 3);
    ta.current.focus({ preventScroll: true });
    ta.current.setSelectionRange(pos, pos);
    onCursor?.(i + 1, 1);
  }, [jump?.n]);

  const cursor = () => {
    const el = ta.current;
    if (!el || !onCursor) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split('\n').length;
    onCursor(line, before.length - before.lastIndexOf('\n'));
  };

  const edit = (next: string, caret: number) => {
    onChange?.(next);
    requestAnimationFrame(() => {
      ta.current?.setSelectionRange(caret, caret);
      cursor();
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value: v } = el;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        if (v[ls] === '\t') edit(v.slice(0, ls) + v.slice(ls + 1), Math.max(ls, s - 1));
        return;
      }
      edit(v.slice(0, s) + '\t' + v.slice(en), s + 1);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const cur = v.slice(ls, s);
      let ind = (cur.match(/^[\t ]*/) ?? [''])[0];
      if (/\{\s*$/.test(cur)) ind += '\t';
      edit(v.slice(0, s) + '\n' + ind + v.slice(en), s + 1 + ind.length);
    } else if (e.key === '}' && !readOnly) {
      // typing a closing brace on an empty indented line takes one level off
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const cur = v.slice(ls, s);
      if (/^\t+$/.test(cur) && s === en) {
        e.preventDefault();
        edit(v.slice(0, ls) + cur.slice(1) + '}' + v.slice(en), s);
      }
    }
  };

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const f = () => cursor();
    document.addEventListener('selectionchange', f);
    return () => document.removeEventListener('selectionchange', f);
  });

  return (
    <div className="cd-code" ref={box}>
      <div className="cd-code-in">
        <div className="cd-gut" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={marks?.[i] ? `is-${marks[i]}` : undefined}>{i + 1}</div>
          ))}
        </div>
        <div className="cd-code-cell">
          <pre aria-hidden="true">
            {lines.map((l, i) => (
              <div key={i} className={marks?.[i] ? `is-${marks[i]}` : undefined}>{highlight(l, ds[i], String(i))}</div>
            ))}
          </pre>
          <textarea
            ref={ta}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            aria-label={label}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={onKey}
            onClick={cursor}
            onKeyUp={cursor}
          />
        </div>
      </div>
    </div>
  );
}
