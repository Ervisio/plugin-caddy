/**
 * Commands declared in plugin/manifest.json, and the errors every call can end with.
 *
 *   const r = await run('version');            // {stdout, stderr, exitCode}; a non-zero exit is a normal result
 *   const out = await runOk('journal', ['500']);  // throws CommandError when the exit code is not 0
 */
import { getSdk, type ExecResult, type PluginError } from '../sdk';

export class CommandError extends Error {
  exitCode: number;
  stderr: string;
  constructor(command: string, r: ExecResult) {
    super((r.stderr || r.stdout).trim().slice(0, 600) || `${command} ended with code ${r.exitCode}`);
    this.name = 'CommandError';
    this.exitCode = r.exitCode;
    this.stderr = r.stderr;
  }
}

export function run(command: string, args: string[] = []): Promise<ExecResult> {
  return getSdk().api.exec(command, args);
}

export async function runOk(command: string, args: string[] = []): Promise<string> {
  const r = await run(command, args);
  if (r.exitCode !== 0) throw new CommandError(command, r);
  return r.stdout;
}

/** Follows a command line by line. Returns a handle whose close() kills it. */
export function follow(command: string, args: string[], onLine: (line: string) => void, onEnd?: (err?: Error) => void): { close(): void } {
  return getSdk().api.execStream(command, args, {
    onLine: (_s, line) => onLine(line),
    onExit: () => onEnd?.(),
    onError: (e) => onEnd?.(e),
  });
}

export type ErrorKind = 'admin' | 'forbidden' | 'unreachable' | 'missing' | 'failed' | 'unknown';

export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
}

/** Sorts any thrown value into something a view can react to. */
export function classify(e: unknown): ErrorInfo {
  const err = e as Partial<PluginError> | undefined;
  const message = err?.message ?? String(e);
  if (e instanceof CommandError) return { kind: 'failed', message };
  switch (err?.code) {
    case 'needs_admin':
      return { kind: 'admin', message };
    case 'forbidden':
      return { kind: 'forbidden', message };
    case 'not_found':
      return { kind: 'missing', message };
    case 'unavailable':
      return { kind: /not found|no such file|executable/i.test(message) ? 'missing' : 'unreachable', message };
    default:
      return { kind: 'unknown', message };
  }
}

export const errorText = (e: unknown): string => classify(e).message;

/** True when the error means "the program is not installed" rather than "it failed". */
export const isMissing = (e: unknown): boolean => classify(e).kind === 'missing';
