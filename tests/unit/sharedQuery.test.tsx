import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { publish } from "../../src/database/dataChanges";
import {
  queryKey,
  readCounts,
  resetReadCounts,
  sharedRead,
  useSharedQuery,
} from "../../src/database/sharedQuery";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);
beforeEach(resetReadCounts);

/** A read the test settles by hand. */
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("equal questions have equal keys whatever the argument order", () => {
  expect(queryKey("a", { x: 1, y: [2, { b: 1, a: 2 }] }, undefined)).toBe(
    queryKey("a", { y: [2, { a: 2, b: 1 }], x: 1 }, null),
  );
  expect(queryKey("a", "2026-01-01")).not.toBe(queryKey("a", "2026-01-02"));
  expect(queryKey("a", null)).not.toBe(queryKey("b", null));
});

test("identical concurrent reads share one request; other scopes do not", async () => {
  const read = vi.fn(async () => 1);
  const other = vi.fn(async () => 2);
  const [a, b, c] = await Promise.all([
    sharedRead("k", ["issues"], read),
    sharedRead("k", ["issues"], read),
    sharedRead("other", ["issues"], other),
  ]);
  expect([a, b, c]).toEqual([1, 1, 2]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(other).toHaveBeenCalledTimes(1);
  expect(readCounts()).toEqual({ started: 2, shared: 1 });
});

test("nothing is kept once a read settles", async () => {
  const read = vi.fn(async () => 1);
  await sharedRead("k2", ["issues"], read);
  await sharedRead("k2", ["issues"], read);
  expect(read).toHaveBeenCalledTimes(2);
});

test("a read that began before a write is not joined after it", async () => {
  const before = gate<string>();
  const first = sharedRead("k3", ["issues"], () => before.promise);
  act(() => publish(["issues"]));
  const second = sharedRead("k3", ["issues"], async () => "after");
  expect(await second).toBe("after");
  before.resolve("before");
  expect(await first).toBe("before");
  // A write to an unrelated source does not split sharing.
  const slow = gate<string>();
  const one = sharedRead("k4", ["issues"], () => slow.promise);
  act(() => publish(["habits"]));
  const two = sharedRead("k4", ["issues"], async () => "never");
  slow.resolve("shared");
  expect(await Promise.all([one, two])).toEqual(["shared", "shared"]);
});

test("a failed read is shared, then forgotten so a retry asks again", async () => {
  const read = vi
    .fn<() => Promise<number>>()
    .mockRejectedValueOnce({ code: "storage_failed" })
    .mockResolvedValue(5);
  const results = await Promise.allSettled([
    sharedRead("k5", ["issues"], read),
    sharedRead("k5", ["issues"], read),
  ]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await sharedRead("k5", ["issues"], read)).toBe(5);
});

test("two widgets with the same question make one request", async () => {
  const read = vi.fn(async () => "numbers");
  const mount = () =>
    renderHook(() => useSharedQuery("same", ["issues"], read, () => "failed"));
  const one = mount();
  const two = mount();
  await waitFor(() => expect(one.result.current.data).toBe("numbers"));
  await waitFor(() => expect(two.result.current.data).toBe("numbers"));
  expect(read).toHaveBeenCalledTimes(1);
});

test("a newer question is never overwritten by an older answer", async () => {
  const old = gate<string>();
  const fresh = gate<string>();
  const { result, rerender } = renderHook(
    ({ key }) =>
      useSharedQuery(
        key,
        ["issues"],
        () => (key === "old" ? old.promise : fresh.promise),
        () => "failed",
      ),
    { initialProps: { key: "old" } },
  );
  rerender({ key: "new" });
  fresh.resolve("new answer");
  await waitFor(() => expect(result.current.data).toBe("new answer"));
  old.resolve("old answer");
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.data).toBe("new answer");
  expect(result.current.loading).toBe(false);
});

test("a write to a source it reads refreshes the widget; others do not", async () => {
  let n = 0;
  const read = vi.fn(async () => ++n);
  const { result } = renderHook(() =>
    useSharedQuery("w", ["issues"], read, () => "failed"),
  );
  await waitFor(() => expect(result.current.data).toBe(1));
  act(() => publish(["habits"]));
  expect(read).toHaveBeenCalledTimes(1);
  act(() => publish(["issues"]));
  await waitFor(() => expect(result.current.data).toBe(2));
});

test("a failed read clears the numbers, explains, and retries", async () => {
  const read = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("ok")
    .mockRejectedValueOnce({ code: "x" })
    .mockResolvedValue("back");
  const { result } = renderHook(() =>
    useSharedQuery("f", ["issues"], read, () => "Could not read."),
  );
  await waitFor(() => expect(result.current.data).toBe("ok"));
  act(() => publish(["issues"]));
  await waitFor(() => expect(result.current.error).toBe("Could not read."));
  expect(result.current.data).toBeNull();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.data).toBe("back"));
  expect(result.current.error).toBe("");
});

test("a null key reads nothing", () => {
  const read = vi.fn(async () => 1);
  const { result } = renderHook(() =>
    useSharedQuery(null, ["issues"], read, () => ""),
  );
  expect(read).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
});
