import { useEffect, useEffectEvent, useState } from "react";
import { useDataVersion, versionOf, type DataSource } from "./dataChanges";

/**
 * Shared analytics reads. Widgets that ask the same question at the same
 * moment share one request; nothing is kept once it settles, so there is no
 * second store and no cache to go stale. See docs/ANALYTICS.md,
 * "Shared reads".
 */

/**
 * A stable key for a read: the command and its arguments, with object keys
 * sorted and undefined treated as null, so equal questions have equal keys.
 */
export function queryKey(command: string, ...args: unknown[]): string {
  const norm = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(norm)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, item]) => [key, norm(item)]),
          )
        : (value ?? null);
  return `${command}:${JSON.stringify(norm(args))}`;
}

interface Flight {
  promise: Promise<unknown>;
  /** The sources' versions when it started. A write moves them. */
  version: number;
}

const flights = new Map<string, Flight>();
const counts = { started: 0, shared: 0 };

/** How many reads started and how many joined one in flight (for tests). */
export const readCounts = () => ({ ...counts });
export function resetReadCounts() {
  counts.started = 0;
  counts.shared = 0;
}

/**
 * Runs `read`, or joins an identical read already in flight. A read that
 * started before a write to one of its `sources` is never joined afterwards,
 * so no consumer receives an answer older than the change it just saw.
 * The entry is removed when the read settles, success or failure, so a retry
 * always asks again.
 */
export function sharedRead<T>(
  key: string,
  sources: readonly DataSource[],
  read: () => Promise<T>,
): Promise<T> {
  const version = versionOf(sources);
  const existing = flights.get(key);
  if (existing && existing.version === version) {
    counts.shared += 1;
    return existing.promise as Promise<T>;
  }
  counts.started += 1;
  const promise = read();
  const flight: Flight = { promise, version };
  flights.set(key, flight);
  const done = () => {
    if (flights.get(key) === flight) flights.delete(key);
  };
  promise.then(done, done);
  return promise;
}

export interface QueryState<T> {
  /** The latest answer for the current question, or the previous one while a new one loads. */
  data: T | null;
  error: string;
  /** True from a change of question or data until its answer arrives. */
  loading: boolean;
  retry: () => void;
}

/**
 * A widget's read. It asks again when the key, its sources, or a retry
 * changes; an answer to an earlier question is ignored whenever it arrives;
 * a failed read clears the numbers and shows its error until retried.
 * `key` is null while the read does not apply.
 */
export function useSharedQuery<T>(
  key: string | null,
  sources: readonly DataSource[],
  read: () => Promise<T>,
  describe: (cause: unknown) => string,
): QueryState<T> {
  const version = useDataVersion(...sources);
  const [retries, setRetries] = useState(0);
  const [result, setResult] = useState<{
    token: string;
    data: T | null;
    error: string;
  }>({ token: "", data: null, error: "" });
  const run = useEffectEvent(() => sharedRead(key!, sources, read));
  const explain = useEffectEvent(describe);
  const token = key === null ? null : `${key}#${version}#${retries}`;

  useEffect(() => {
    if (token === null) return;
    let live = true;
    run().then(
      (data) => live && setResult({ token, data, error: "" }),
      (cause) =>
        live && setResult({ token, data: null, error: explain(cause) }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  return {
    data: result.data,
    error: result.error,
    loading: token !== null && result.token !== token,
    retry: () => setRetries((n) => n + 1),
  };
}
