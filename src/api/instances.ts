/**
 * Finds the Caddy servers on this machine: the system service (caddy.service) and every Docker container that runs
 * Caddy. Docker is only asked when the socket exists, and without an unlock prompt unless the user allows it (members
 * of the docker group and root use the socket as themselves).
 */
import { inspect, listContainers, type ContainerInspect, type ContainerSummary } from './docker';
import { classify, run } from './run';

export type InstanceKind = 'system' | 'docker';
export type Unsupported = 'labels' | 'path' | 'json' | 'noshell';

export interface Instance {
  /** Stable id: "system" or "docker-<container name>". Used for history and the remembered choice. */
  key: string;
  kind: InstanceKind;
  name: string;
  version: string;
  running: boolean;
  /** When the server started (ms), when known. */
  since?: number;
  /** The Caddyfile as Caddy sees it (inside the container for Docker). */
  configPath: string;
  /** Docker: where the Caddyfile lives on this machine, when it is mounted. */
  configHost?: string;
  /** Docker: Caddy's data folder inside the container (certificates). */
  dataDir?: string;
  container?: { id: string; name: string; image: string; stack?: string; networks: string[] };
  unsupported?: Unsupported;
}

export const DEFAULT_CONFIG = '/etc/caddy/Caddyfile';

/* ---------- system service ---------- */

function prop(out: string, name: string): string {
  const m = out.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

/** "Thu 2026-10-01 09:12:04 CEST" -> ms (read as local time; good enough for "up 3 days"). */
export function parseSystemdTime(s: string): number | undefined {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** The value of --config in a command line, or the default. */
export function configFromArgv(argv: string[]): string {
  const i = argv.findIndex((a) => a === '--config' || a === '-c');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--config='));
  return eq ? eq.slice(9) : DEFAULT_CONFIG;
}

export async function detectSystem(): Promise<Instance | null> {
  let out: string;
  try {
    const r = await run('service-show');
    out = r.stdout;
  } catch {
    return null;
  }
  if (prop(out, 'LoadState') !== 'loaded') return null;
  const exec = prop(out, 'ExecStart');
  const argv = (exec.match(/argv\[\]=([^;]*)/)?.[1] ?? '').trim().split(/\s+/);
  const configPath = configFromArgv(argv);
  let version = '';
  try {
    const v = await run('version');
    version = v.stdout.trim().split(/\s+/)[0]?.replace(/^v/, '') ?? '';
  } catch {
    /* caddy not in PATH: the unit may point elsewhere */
  }
  const running = prop(out, 'ActiveState') === 'active';
  let unsupported: Unsupported | undefined;
  if (argv.includes('--resume') || /\.json$/i.test(configPath)) unsupported = 'json';
  else if (!configPath.startsWith('/etc/caddy/')) unsupported = 'path';
  return {
    key: 'system',
    kind: 'system',
    name: 'Caddy',
    version,
    running,
    since: running ? parseSystemdTime(prop(out, 'ExecMainStartTimestamp')) : undefined,
    configPath,
    unsupported,
  };
}

/* ---------- Docker ---------- */

export interface DockerAccess {
  /** The socket exists. */
  present: boolean;
  /** The user can use it without unlocking (root or docker group). */
  direct: boolean;
}

export async function dockerAccess(): Promise<DockerAccess> {
  try {
    const has = await run('has-docker');
    if (has.exitCode !== 0) return { present: false, direct: false };
  } catch {
    return { present: false, direct: false };
  }
  try {
    const [u, g] = await Promise.all([run('user'), run('groups')]);
    const groups = g.stdout.trim().split(/\s+/);
    return { present: true, direct: u.stdout.trim() === 'root' || groups.includes('docker') };
  } catch {
    return { present: true, direct: false };
  }
}

const PROXY_IMAGE = /caddy-docker-proxy/i;

/** A container that runs Caddy: its image is caddy (any registry or tag), or its command is caddy. */
export function looksLikeCaddy(c: ContainerSummary): boolean {
  const img = c.Image.toLowerCase();
  const base = img.split('@')[0].split('/').pop()!.split(':')[0];
  if (base === 'caddy' || base.startsWith('caddy-') || base.endsWith('-caddy') || PROXY_IMAGE.test(img)) return true;
  return /^(\/usr\/bin\/)?caddy\s+(run|docker-proxy)/.test(c.Command.replace(/^"|"$/g, ''));
}

export function instanceFromInspect(c: ContainerInspect): Instance {
  const name = c.Name.replace(/^\//, '');
  const argv = [...(c.Config.Entrypoint ?? []), ...(c.Config.Cmd ?? [])];
  const configPath = configFromArgv(argv);
  const env = Object.fromEntries((c.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const version = (env.CADDY_VERSION ?? '').replace(/^v/, '') || (c.Config.Image.split(':')[1] ?? '');
  const dataHome = env.XDG_DATA_HOME || `${env.HOME || '/root'}/.local/share`;
  const mount = c.Mounts.filter((m) => configPath === m.Destination || configPath.startsWith(m.Destination.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  const configHost = mount && mount.Type === 'bind' ? mount.Source + configPath.slice(mount.Destination.length) : undefined;
  let unsupported: Unsupported | undefined;
  if (PROXY_IMAGE.test(c.Config.Image) || argv.includes('docker-proxy')) unsupported = 'labels';
  else if (argv.includes('--resume') || /\.json$/i.test(configPath)) unsupported = 'json';
  const started = Date.parse(c.State.StartedAt);
  return {
    key: `docker-${name}`,
    kind: 'docker',
    name,
    version,
    running: c.State.Running,
    since: c.State.Running && started > 0 ? started : undefined,
    configPath,
    configHost,
    dataDir: `${dataHome}/caddy`,
    container: {
      id: c.Id,
      name,
      image: c.Config.Image,
      stack: c.Config.Labels?.['com.docker.compose.project'],
      networks: Object.keys(c.NetworkSettings.Networks ?? {}),
    },
    unsupported,
  };
}

export async function detectDocker(): Promise<Instance[]> {
  const list = await listContainers();
  const found = list.filter(looksLikeCaddy);
  const out = await Promise.all(found.map((c) => inspect(c.Id).then(instanceFromInspect)));
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

export interface Detection {
  instances: Instance[];
  docker: DockerAccess;
  /** Docker was not asked (needs an unlock the user has not allowed yet). */
  dockerSkipped: boolean;
  dockerError?: string;
}

/** Looks for every Caddy. `askDocker` = use Docker even when it needs administrator rights (an unlock prompt). */
export async function detectAll(askDocker: boolean): Promise<Detection> {
  const [sys, docker] = await Promise.all([detectSystem(), dockerAccess()]);
  const instances: Instance[] = sys ? [sys] : [];
  let dockerSkipped = false;
  let dockerError: string | undefined;
  if (docker.present && (docker.direct || askDocker)) {
    try {
      instances.push(...(await detectDocker()));
    } catch (e) {
      dockerError = classify(e).message;
    }
  } else if (docker.present) dockerSkipped = true;
  return { instances, docker, dockerSkipped, dockerError };
}
