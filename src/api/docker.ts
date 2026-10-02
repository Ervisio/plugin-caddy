/**
 * The small part of the Docker Engine API this plugin needs, over sdk.api.http('docker', ...): list and inspect
 * containers, start/stop/restart one, read its logs and run a command in it (exec). The API version is negotiated
 * once with GET /version. Paths are passed without the version prefix.
 */
import { getSdk, type HttpResponse, type Query } from '../sdk';

const NAME = 'docker';

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

let version: Promise<string> | undefined;

function apiVersion(): Promise<string> {
  if (!version) {
    version = getSdk()
      .api.http(NAME, { method: 'GET', path: '/version' })
      .then((r) => {
        if (r.status >= 400) throw toError(r);
        return (r.json() as { ApiVersion: string }).ApiVersion;
      })
      .catch((e) => {
        version = undefined;
        throw e;
      });
  }
  return version;
}

function toError(r: HttpResponse): DockerError {
  let msg = '';
  try {
    msg = (r.json() as { message?: string }).message ?? '';
  } catch {
    msg = r.body?.slice(0, 300) ?? '';
  }
  return new DockerError(r.status, msg || `Docker answered ${r.status}`);
}

async function request(method: string, path: string, query?: Query, body?: unknown): Promise<HttpResponse> {
  const v = await apiVersion();
  return getSdk().api.http(NAME, { method, path: `/v${v}${path}`, query, body: body as never });
}

async function json<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
  const r = await request(method, path, query, body);
  if (r.status >= 400) throw toError(r);
  return (r.body ? r.json() : undefined) as T;
}

/* ---------- types (only the fields used) ---------- */

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  Command: string;
  State: string;
  Status: string;
  Labels: Record<string, string> | null;
  Ports: { PrivatePort: number; PublicPort?: number; Type: string; IP?: string }[];
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean; StartedAt: string };
  Config: { Image: string; Cmd: string[] | null; Entrypoint: string[] | null; Env: string[] | null; Labels: Record<string, string> | null; ExposedPorts?: Record<string, unknown> | null };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress?: string; Aliases?: string[] | null }> };
}

export const listContainers = () => json<ContainerSummary[]>('GET', '/containers/json', { all: '1' });
export const inspect = (id: string) => json<ContainerInspect>('GET', `/containers/${encodeURIComponent(id)}/json`);
export const containerAction = (id: string, action: 'start' | 'stop' | 'restart') =>
  json<void>('POST', `/containers/${encodeURIComponent(id)}/${action}`);

/* ---------- multiplexed streams (logs and exec without a tty) ---------- */

/** Splits Docker's frames: an 8-byte header [stream, 0, 0, 0, size uint32 BE] then `size` bytes. */
export class Demux {
  private pending = new Uint8Array(0);
  constructor(private onFrame: (stream: number, data: Uint8Array) => void) {}
  push(chunk: Uint8Array): void {
    let buf = chunk;
    if (this.pending.length) {
      buf = new Uint8Array(this.pending.length + chunk.length);
      buf.set(this.pending);
      buf.set(chunk, this.pending.length);
    }
    let i = 0;
    while (buf.length - i >= 8) {
      const size = ((buf[i + 4] << 24) >>> 0) + (buf[i + 5] << 16) + (buf[i + 6] << 8) + buf[i + 7];
      if (buf.length - i - 8 < size) break;
      this.onFrame(buf[i], buf.subarray(i + 8, i + 8 + size));
      i += 8 + size;
    }
    this.pending = buf.slice(i);
  }
}

function demuxAll(bytes: Uint8Array): { stdout: string; stderr: string } {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  // A container started with a tty sends raw bytes; frames always start with 0, 1 or 2 followed by three zeros.
  const framed = bytes.length >= 8 && bytes[0] <= 2 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
  if (!framed) return { stdout: new TextDecoder().decode(bytes), stderr: '' };
  new Demux((s, d) => (s === 2 ? err : out).push(d.slice())).push(bytes);
  const join = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
  return { stdout: join(out), stderr: join(err) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command inside a container and waits for it. */
export async function execIn(container: string, cmd: string[], env?: string[]): Promise<ExecOutput> {
  const created = await json<{ Id: string }>('POST', `/containers/${encodeURIComponent(container)}/exec`, undefined, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: cmd,
    Env: env,
  });
  const r = await request('POST', `/exec/${created.Id}/start`, undefined, { Detach: false, Tty: false });
  if (r.status >= 400) throw toError(r);
  const { stdout, stderr } = demuxAll(r.bytes());
  const info = await json<{ ExitCode: number | null }>('GET', `/exec/${created.Id}/json`);
  return { exitCode: info.ExitCode ?? -1, stdout, stderr };
}

/** The last `tail` lines of a container's output (stdout and stderr, in order). */
export async function containerLogs(id: string, tail: number): Promise<string[]> {
  const r = await request('GET', `/containers/${encodeURIComponent(id)}/logs`, { stdout: '1', stderr: '1', tail: String(tail) });
  if (r.status >= 400) throw toError(r);
  const lines: string[] = [];
  const bytes = r.bytes();
  const framed = bytes.length >= 8 && bytes[0] <= 2 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0;
  const dec = new TextDecoder();
  if (!framed) return dec.decode(bytes).split('\n').filter(Boolean);
  let buf = '';
  new Demux((_s, d) => {
    buf += dec.decode(d);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }).push(bytes);
  if (buf) lines.push(buf);
  return lines;
}

/** Follows a container's output from now on, one call per line. */
export function followContainer(id: string, onLine: (line: string) => void, onEnd?: (e?: Error) => void): { close(): void } {
  let closed = false;
  let inner: { close(): void } | undefined;
  apiVersion()
    .then((v) => {
      if (closed) return;
      const dec = new TextDecoder();
      let buf = '';
      const feed = (d: Uint8Array) => {
        buf += dec.decode(d, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      };
      const demux = new Demux((_s, d) => feed(d));
      let framed: boolean | undefined;
      inner = getSdk().api.httpStream(
        NAME,
        { method: 'GET', path: `/v${v}/containers/${encodeURIComponent(id)}/logs`, query: { stdout: '1', stderr: '1', follow: '1', tail: '0' } },
        {
          onData: (c) => {
            if (framed === undefined) framed = c.length >= 8 && c[0] <= 2 && c[1] === 0 && c[2] === 0 && c[3] === 0;
            if (framed) demux.push(c);
            else feed(c);
          },
          onEnd: () => onEnd?.(),
          onError: (e) => onEnd?.(e),
        },
      );
    })
    .catch((e) => onEnd?.(e));
  return {
    close() {
      closed = true;
      inner?.close();
    },
  };
}

export const resetDocker = () => {
  version = undefined;
};
