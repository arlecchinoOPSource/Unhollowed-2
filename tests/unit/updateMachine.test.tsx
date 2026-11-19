// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isBusy,
  transition,
  type UpdateEvent,
  type UpdateState,
} from "../../src/features/updates/updateMachine";

// U2-P7-04: one state at a time, and events that do not apply are ignored.
const run = (events: UpdateEvent[], from: UpdateState = { phase: "idle" }) =>
  events.reduce(transition, from);
const available = {
  status: "available" as const,
  currentVersion: "1.0.0-beta.1",
  version: "1.1.0-beta.1",
  date: "2026-11-20T10:00:00Z",
  notes: "Fixes",
};
const checked = (event: UpdateEvent) => run([{ type: "check" }, event]);

describe("update state machine", () => {
  it("walks the full path from idle to restarting", () => {
    const phases: string[] = [];
    let state: UpdateState = { phase: "idle" };
    for (const event of [
      { type: "check" },
      { type: "checked", result: available },
      { type: "download" },
      { type: "progress", downloaded: 10, total: 100 },
      { type: "downloaded" },
      { type: "verified" },
      { type: "installed" },
    ] as UpdateEvent[]) {
      state = transition(state, event);
      phases.push(state.phase);
    }
    expect(phases).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "verifying",
      "installing",
      "restarting",
    ]);
  });

  it("maps every check result to one state", () => {
    expect(
      checked({
        type: "checked",
        result: { status: "current", currentVersion: "1.0.0" },
      }),
    ).toEqual({ phase: "upToDate", currentVersion: "1.0.0" });
    expect(checked({ type: "checked", result: available }).phase).toBe(
      "available",
    );
    expect(
      checked({
        type: "checked",
        result: { status: "unsupported", target: "linux-x86_64" },
      }),
    ).toMatchObject({ phase: "error", reason: "unsupported" });
    expect(
      checked({
        type: "checked",
        result: { status: "failed", reason: "offline", detail: "x" },
      }),
    ).toMatchObject({ phase: "error", reason: "offline" });
    // A native "busy" answer must not leave the screen checking forever.
    expect(checked({ type: "checked", result: { status: "busy" } }).phase).toBe(
      "error",
    );
  });

  it("ignores a second check while one is running", () => {
    const checking = run([{ type: "check" }]);
    expect(transition(checking, { type: "check" })).toBe(checking);
    expect(isBusy(checking)).toBe(true);
  });

  it("ignores events that do not apply, so no contradictory state appears", () => {
    const idle: UpdateState = { phase: "idle" };
    for (const event of [
      { type: "checked", result: available },
      { type: "download" },
      { type: "progress", downloaded: 5, total: 10 },
      { type: "downloaded" },
      { type: "verified" },
      { type: "installed" },
      { type: "failed", reason: "download", detail: "x" },
    ] as UpdateEvent[])
      expect(transition(idle, event)).toBe(idle);
    const upToDate = checked({
      type: "checked",
      result: { status: "current", currentVersion: "1" },
    });
    expect(transition(upToDate, { type: "download" })).toBe(upToDate);
  });

  it("keeps byte progress monotonic and keeps a known total", () => {
    const downloading = run([
      { type: "check" },
      { type: "checked", result: available },
      { type: "download" },
      { type: "progress", downloaded: 50, total: 100 },
      { type: "progress", downloaded: 20, total: null },
    ]);
    expect(downloading).toMatchObject({ downloaded: 50, total: 100 });
  });

  it("fails only from an operation, and cannot be dismissed mid-operation", () => {
    const downloading = run([
      { type: "check" },
      { type: "checked", result: available },
      { type: "download" },
    ]);
    expect(transition(downloading, { type: "dismiss" })).toBe(downloading);
    const failed = transition(downloading, {
      type: "failed",
      reason: "verification",
      detail: "bad signature",
    });
    expect(failed).toMatchObject({ phase: "error", reason: "verification" });
    expect(isBusy(failed)).toBe(false);
    expect(transition(failed, { type: "dismiss" })).toEqual({ phase: "idle" });
    expect(transition(failed, { type: "check" })).toEqual({
      phase: "checking",
    });
  });
});
