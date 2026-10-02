import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addSite, diffLines, format, formOf, generateSite, importedFiles, lineMarks, parse, removeSite, replaceSite,
  setSiteEnabled, summarize, upstreamURL, publicNames, emptyForm,
} from '../src/api/caddyfile.ts';

const sample = readFileSync(new URL('./sample.Caddyfile', import.meta.url), 'utf8');

test('blocks and sites', () => {
  const d = parse(sample);
  assert.deepEqual(d.blocks.map((b) => b.kind), ['global', 'snippet', 'site', 'site', 'site', 'site', 'site', 'site', 'site', 'import']);
  assert.deepEqual(d.snippets, ['secure']);
  assert.deepEqual(d.imports, ['secure', 'secure', 'sites/*.caddy'].filter((x) => x === 'sites/*.caddy'));
  const names = d.sites.map((s) => s.addresses.join(','));
  assert.deepEqual(names, ['photos.fonlogen.it', 'cloud.fonlogen.it', 'vault.fonlogen.it', 'admin.fonlogen.it', 'status.fonlogen.it', 'fonlogen.it,www.fonlogen.it', 'old.fonlogen.it']);
});

test('site models', () => {
  const s = Object.fromEntries(parse(sample).sites.map((x) => [x.addresses[0], x]));
  assert.equal(s['photos.fonlogen.it'].kind, 'proxy');
  assert.equal(s['photos.fonlogen.it'].target, 'immich-server:2283');
  assert.equal(s['photos.fonlogen.it'].options.compress, true);
  assert.equal(s['photos.fonlogen.it'].extra.length, 1); // request_body
  assert.equal(s['vault.fonlogen.it'].options.accessLog, true);
  assert.equal(s['vault.fonlogen.it'].options.logFile, '/var/log/caddy/vault.log');
  assert.deepEqual(s['vault.fonlogen.it'].extra, ['import secure']);
  assert.equal(s['admin.fonlogen.it'].options.auth?.user, 'fonlogen');
  assert.equal(s['fonlogen.it'].kind, 'static');
  assert.equal(s['fonlogen.it'].root, '/srv/www/fonlogen');
  assert.equal(s['old.fonlogen.it'].kind, 'redirect');
  assert.equal(s['old.fonlogen.it'].redirectTo, 'https://fonlogen.it{uri}');
  assert.equal(s['cloud.fonlogen.it'].kind, 'proxy');
  assert.equal(s['cloud.fonlogen.it'].extra.length, 2);
});

test('unchanged form regenerates the same lines (modulo order)', () => {
  for (const site of parse(sample).sites) {
    const block = generateSite(formOf(site), site);
    const again = parse(block).sites[0];
    assert.deepEqual(formOf(again), formOf(site), site.addresses[0]);
    assert.deepEqual(again.extra, site.extra, site.addresses[0]);
  }
});

test('replace touches only the block', () => {
  const d = parse(sample);
  const site = d.sites.find((s) => s.addresses[0] === 'status.fonlogen.it')!;
  const f = formOf(site);
  f.target = 'uptime-kuma:3002';
  f.options.compress = true;
  const out = replaceSite(sample, site, generateSite(f, site));
  const ops = diffLines(sample.split('\n'), out.split('\n')).filter((o) => o.t !== '=');
  assert.deepEqual(ops.map((o) => o.t + o.line), ['-\treverse_proxy uptime-kuma:3001', '+\treverse_proxy uptime-kuma:3002', '+\tencode zstd gzip']);
  assert.equal(parse(out).sites.length, 7);
});

test('turn off and on round-trip', () => {
  const d = parse(sample);
  const site = d.sites[2];
  const off = setSiteEnabled(sample, site, false);
  const d2 = parse(off);
  const s2 = d2.sites.find((s) => s.addresses[0] === site.addresses[0])!;
  assert.equal(s2.disabled, true);
  assert.equal(s2.kind, site.kind);
  assert.equal(d2.sites.length, 7);
  assert.equal(setSiteEnabled(off, s2, true), sample);
  // editing a site that is off keeps it off
  const f = formOf(s2);
  f.target = 'x:1';
  const edited = replaceSite(off, s2, generateSite(f, s2));
  assert.equal(parse(edited).sites.find((s) => s.addresses[0] === site.addresses[0])!.disabled, true);
});

test('add and remove', () => {
  const f = emptyForm();
  f.addresses = ['new.example.org'];
  f.target = 'localhost:8080';
  const out = addSite(sample, generateSite(f));
  const d = parse(out);
  assert.equal(d.sites.length, 8);
  const n = d.sites.find((s) => s.addresses[0] === 'new.example.org')!;
  assert.equal(n.kind, 'proxy');
  assert.equal(n.options.compress, true);
  const back = removeSite(out, n);
  assert.equal(back.trimEnd(), sample.trimEnd());
  assert.equal(parse(removeSite(sample, parse(sample).sites[0])).sites.length, 6);
});

test('format', () => {
  const messy = 'a.com {\n      reverse_proxy x:1   \n\n\n  header {\n X-A b\n }\n}\n';
  assert.equal(format(messy), 'a.com {\n\treverse_proxy x:1\n\n\theader {\n\t\tX-A b\n\t}\n}\n');
  assert.equal(format(sample), sample);
});

test('placeholders and quotes do not open blocks', () => {
  const t = 'a.com {\n\trespond "{ not a block }" 200\n\tredir https://b.com{uri}\n}\nb.com {\n\trespond `x\n}` 200\n}\n';
  const d = parse(t);
  assert.equal(d.sites.length, 2);
  assert.equal(d.sites[1].start, 4);
  assert.equal(d.sites[1].end, 7);
});

test('helpers', () => {
  assert.equal(upstreamURL('immich-server:2283'), 'http://immich-server:2283');
  assert.equal(upstreamURL('https://x.lan'), 'https://x.lan:443');
  assert.equal(upstreamURL('unix//run/php.sock'), null);
  assert.equal(upstreamURL('{$UP}'), null);
  assert.deepEqual(publicNames(['fonlogen.it', 'grafana.lan', 'localhost', ':8080', 'http://x.org:8080']), ['fonlogen.it', 'x.org']);
  const marks = lineMarks('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(marks, ['', 'chg', '', 'add']);
  const s = summarize(sample, setSiteEnabled(sample, parse(sample).sites[0], false));
  assert.deepEqual(s.off, ['photos.fonlogen.it']);
  assert.deepEqual(importedFiles(parse(sample), '/etc/caddy/Caddyfile', ['/etc/caddy/Caddyfile', '/etc/caddy/sites/a.caddy', '/etc/caddy/x.txt']), ['/etc/caddy/sites/a.caddy']);
});
