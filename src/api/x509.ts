/**
 * Just enough X.509 to show a certificate: names, issuer, validity, key type. DER is read by hand (no library):
 * Certificate = SEQUENCE { tbsCertificate, signatureAlgorithm, signature }.
 */

export interface CertInfo {
  names: string[];
  subjectCN: string;
  issuerCN: string;
  issuerO: string;
  notBefore: number;
  notAfter: number;
  key: string;
  serial: string;
  /** SHA-256 of the DER, "AB:CD:…" (empty when the browser has no WebCrypto here). */
  fingerprint: string;
  der: Uint8Array;
}

interface TLV {
  tag: number;
  start: number; // start of the value
  len: number;
  end: number; // end of the value
}

function tlv(b: Uint8Array, at: number): TLV {
  const tag = b[at];
  let len = b[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  return { tag, start: p, len, end: p + len };
}

function children(b: Uint8Array, t: TLV): TLV[] {
  const out: TLV[] = [];
  let p = t.start;
  while (p < t.end) {
    const c = tlv(b, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function oid(b: Uint8Array, t: TLV): string {
  const v = b.subarray(t.start, t.end);
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join('.');
}

const text = (b: Uint8Array, t: TLV) => new TextDecoder().decode(b.subarray(t.start, t.end));

function time(b: Uint8Array, t: TLV): number {
  const s = text(b, t);
  const m = t.tag === 0x17 ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/) : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/);
  if (!m) return 0;
  let y = +m[1];
  if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

function name(b: Uint8Array, t: TLV): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of children(b, t))
    for (const atv of children(b, set)) {
      const [o, v] = children(b, atv);
      out[oid(b, o)] = text(b, v);
    }
  return out;
}

const CURVES: Record<string, string> = { '1.2.840.10045.3.1.7': 'ECDSA P-256', '1.3.132.0.34': 'ECDSA P-384', '1.3.132.0.35': 'ECDSA P-521' };

export function pemBlocks(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) {
    const bin = atob(m[1].replace(/\s+/g, ''));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    out.push(u);
  }
  return out;
}

export function parseDER(der: Uint8Array): CertInfo {
  const cert = tlv(der, 0);
  const tbs = children(der, cert)[0];
  let f = children(der, tbs);
  if (f[0].tag === 0xa0) f = f.slice(1); // [0] version
  const [serialT, , issuerT, validityT, subjectT, spkiT, ...rest] = f;
  const [nb, na] = children(der, validityT);
  const issuer = name(der, issuerT);
  const subject = name(der, subjectT);
  const algSeq = children(der, children(der, spkiT)[0]);
  const algOid = oid(der, algSeq[0]);
  let key = algOid;
  if (algOid === '1.2.840.10045.2.1') key = CURVES[algSeq[1] ? oid(der, algSeq[1]) : ''] ?? 'ECDSA';
  else if (algOid === '1.2.840.113549.1.1.1') {
    const bits = children(der, spkiT)[1];
    const rsa = tlv(der, bits.start + 1);
    const mod = children(der, rsa)[0];
    key = `RSA ${Math.round(((mod.len - (der[mod.start] === 0 ? 1 : 0)) * 8) / 1024) * 1024}`;
  } else if (algOid === '1.3.101.112') key = 'Ed25519';
  const names: string[] = [];
  const ext = rest.find((x) => x.tag === 0xa3);
  if (ext) {
    for (const e of children(der, children(der, ext)[0])) {
      const parts = children(der, e);
      if (oid(der, parts[0]) !== '2.5.29.17') continue;
      const octet = parts[parts.length - 1];
      for (const gn of children(der, tlv(der, octet.start))) {
        if (gn.tag === 0x82) names.push(text(der, gn));
        else if (gn.tag === 0x87) {
          const v = der.subarray(gn.start, gn.end);
          names.push(v.length === 4 ? Array.from(v).join('.') : Array.from(v).map((x) => x.toString(16).padStart(2, '0')).join(''));
        }
      }
    }
  }
  const serial = Array.from(der.subarray(serialT.start, serialT.end))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
  return {
    names: names.length ? names : subject['2.5.4.3'] ? [subject['2.5.4.3']] : [],
    subjectCN: subject['2.5.4.3'] ?? '',
    issuerCN: issuer['2.5.4.3'] ?? '',
    issuerO: issuer['2.5.4.10'] ?? '',
    notBefore: time(der, nb),
    notAfter: time(der, na),
    key,
    serial,
    fingerprint: '',
    der,
  };
}

/** Parses the first certificate of a PEM file (the leaf; the rest is the chain). */
export async function parsePEM(pem: string): Promise<CertInfo | null> {
  const der = pemBlocks(pem)[0];
  if (!der) return null;
  const info = parseDER(der);
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der as BufferSource));
    info.fingerprint = Array.from(h)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(':')
      .toUpperCase();
  } catch {
    /* no WebCrypto in an insecure context */
  }
  return info;
}
