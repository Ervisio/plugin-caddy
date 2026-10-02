import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parsePEM } from '../src/api/x509.ts';

test('EC certificate with SANs', async () => {
  const pem = readFileSync(new URL('./ec.pem', import.meta.url), 'utf8');
  const c = (await parsePEM(pem))!;
  assert.deepEqual(c.names, ['vault.fonlogen.it', 'www.vault.fonlogen.it', '10.0.0.1']);
  assert.equal(c.key, 'ECDSA P-256');
  assert.equal(c.issuerO, 'Test');
  const end = execFileSync('openssl', ['x509', '-noout', '-enddate'], { input: pem }).toString().trim().slice(9);
  assert.equal(c.notAfter, Date.parse(end));
  const fp = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256'], { input: pem }).toString().trim().split('=')[1];
  assert.equal(c.fingerprint, fp);
});

test('RSA certificate without SANs', async () => {
  const c = (await parsePEM(readFileSync(new URL('./rsa.pem', import.meta.url), 'utf8')))!;
  assert.deepEqual(c.names, ['rsa.example.org']);
  assert.equal(c.key, 'RSA 2048');
  assert.ok(c.notAfter - c.notBefore > 29 * 86400e3);
});
