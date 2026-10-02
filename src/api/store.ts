/**
 * Tiny stores for React: a value, subscribers, and a hook.
 *
 *   const s = store({ n: 0 });  s.set({ n: 1 });  const v = s.use();
 *   const r = resource(() => fetchThing());  r.refresh();  const { data, error, loading } = r.use();
 */
import { useSyncExternalStore } from 'react';
import { classify, type ErrorInfo } from './run';

export interface Store<T> {
  get(): T;
  set(v: T | ((old: T) => T)): void;
  use(): T;
  subscribe(f: () => void): () => void;
}

export function store<T>(initial: T): Store<T> {
  let v = initial;
  const subs = new Set<() => void>();
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => subs.delete(f);
  };
  return {
    get: () => v,
    set(next) {
      v = typeof next === 'function' ? (next as (o: T) => T)(v) : next;
      subs.forEach((f) => f());
    },
    use: () => useSyncExternalStore(subscribe, () => v),
    subscribe,
  };
}

export interface ResourceState<T> {
  data: T | undefined;
  error: ErrorInfo | null;
  loading: boolean;
  at: number;
}

export interface Resource<T> extends Store<ResourceState<T>> {
  refresh(): Promise<void>;
  /** Fetch once if never fetched (or after `maxAgeMs`). */
  ensure(maxAgeMs?: number): Promise<void>;
}

export function resource<T>(fetcher: () => Promise<T>): Resource<T> {
  const s = store<ResourceState<T>>({ data: undefined, error: null, loading: false, at: 0 });
  let inflight: Promise<void> | undefined;
  const refresh = () => {
    if (inflight) return inflight;
    s.set((o) => ({ ...o, loading: true }));
    inflight = fetcher()
      .then((data) => s.set({ data, error: null, loading: false, at: Date.now() }))
      .catch((e) => s.set((o) => ({ ...o, error: classify(e), loading: false, at: Date.now() })))
      .finally(() => (inflight = undefined));
    return inflight;
  };
  return {
    ...s,
    refresh,
    ensure(maxAgeMs = Infinity) {
      const st = s.get();
      if (inflight) return inflight;
      if (!st.at || Date.now() - st.at > maxAgeMs) return refresh();
      return Promise.resolve();
    },
  };
}

const noSub = () => () => {};
const none = () => undefined;

/** Like `s.use()`, for a store that may not exist yet (hooks must run on every render). */
export function useMaybe<T>(s: Store<T> | undefined): T | undefined {
  return useSyncExternalStore(s ? s.subscribe : noSub, s ? s.get : none);
}
