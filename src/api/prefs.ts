/** Per-user settings of the plugin, in ~/.config/ervisio/plugins/caddy/prefs.json. */
import { getSdk } from '../sdk';

export interface Prefs {
  /** The instance chosen last (Instance.key). */
  instance?: string;
  /** Look for Caddy in Docker even when that needs administrator rights. */
  askDocker?: boolean;
}

const PATH = '~/.config/ervisio/plugins/caddy/prefs.json';
let cached: Prefs | undefined;

export async function loadPrefs(): Promise<Prefs> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await getSdk().files.read(PATH)) as Prefs;
  } catch {
    cached = {};
  }
  return cached;
}

export async function savePrefs(p: Partial<Prefs>): Promise<void> {
  cached = { ...(await loadPrefs()), ...p };
  try {
    await getSdk().files.write(PATH, JSON.stringify(cached, null, 1));
  } catch {
    /* not fatal: the choice is just not remembered */
  }
}
