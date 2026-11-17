import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  invoke,
  MUTATIONS,
  publish,
  useDataVersion,
  versionOf,
} from "../../src/database/dataChanges";
import { getHabitStatistics } from "../../src/database/habits";
import type { HabitStatistics } from "../../src/database/habits";
import { HabitDashboard } from "../../src/features/habits/HabitDashboard";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

afterEach(cleanup);
beforeEach(() => tauri.invoke.mockReset());

test("publishing moves only the sources it names, and readers re-render", () => {
  const habits = renderHook(() => useDataVersion("habits"));
  const issues = renderHook(() => useDataVersion("issues", "milestones"));
  const before = [habits.result.current, issues.result.current];
  act(() => publish(["habits"]));
  expect(habits.result.current).toBe(before[0] + 1);
  expect(issues.result.current).toBe(before[1]);
  act(() => publish(["milestones", "habits"]));
  expect(habits.result.current).toBe(before[0] + 2);
  expect(issues.result.current).toBe(before[1] + 1);
});

test("a successful write publishes after it resolves; failures and reads do not", async () => {
  const start = versionOf(["habits", "checkins"]);
  tauri.invoke.mockResolvedValueOnce(true);
  await invoke("set_habit_completion", {
    id: "h",
    date: "2026-11-17",
    done: true,
  });
  expect(versionOf(["habits"])).toBeGreaterThan(versionOf([]));
  expect(versionOf(["habits", "checkins"])).toBe(start + 1);

  tauri.invoke.mockRejectedValueOnce({ code: "storage_failed" });
  await expect(invoke("save_checkin", { date: "2026-11-17" })).rejects.toEqual({
    code: "storage_failed",
  });
  tauri.invoke.mockResolvedValueOnce([]);
  await invoke("list_habits");
  tauri.invoke.mockResolvedValueOnce(null);
  await invoke("get_checkin", { date: "2026-11-17" });
  expect(versionOf(["habits", "checkins"])).toBe(start + 1);

  // A write that touches several sources wakes all of them.
  const issues = versionOf(["issues", "projects", "milestones"]);
  tauri.invoke.mockResolvedValueOnce({});
  await invoke("complete_issue", { id: "i" });
  expect(versionOf(["issues", "projects", "milestones"])).toBe(issues + 3);
});

test("only commands that write are in the table", () => {
  for (const command of Object.keys(MUTATIONS))
    expect(command).not.toMatch(
      /^(list|get|query|search|export|preview|pick|claim)_/,
    );
  // Spot checks across modules.
  for (const command of [
    "create_habit",
    "save_checkin",
    "update_issue",
    "close_milestone",
    "change_project_status",
    "delete_issue_work_block",
    "import_ics",
  ])
    expect(MUTATIONS[command]?.length).toBeGreaterThan(0);
});

vi.mock("../../src/database/habits", async (original) => ({
  ...(await original<typeof import("../../src/database/habits")>()),
  getHabitStatistics: vi.fn(),
}));

const stats = (percent: number | null): HabitStatistics => ({
  today: "2026-11-17",
  from: "2026-10-19",
  to: "2026-11-17",
  through: "2026-11-17",
  summary: {
    eligible: 10,
    completed: percent === null ? 0 : percent / 10,
    percent,
  },
  habits: [
    {
      habitId: "h",
      name: "Walk",
      archived: false,
      eligible: 10,
      completed: 1,
      percent,
      streaks: { current: 0, longest: 0 },
    },
  ],
  days: [],
  weeks: [],
  months: [],
  practice: { current: 0, longest: 0 },
});

/** The tile's value, not the same number in the per-habit table. */
const rate = () =>
  screen.getByText("Completion rate").closest("div")!.querySelector("dd")!;
const showsRate = (text: string) =>
  waitFor(() => expect(rate()).toHaveTextContent(text));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test("a superseded response never replaces the current one", async () => {
  const slow = deferred<HabitStatistics>();
  vi.mocked(getHabitStatistics)
    .mockReturnValueOnce(slow.promise)
    .mockResolvedValueOnce(stats(50));
  render(<HabitDashboard reload={0} />);
  // The period changes while the first request is still running.
  fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
  await showsRate("50%");
  // The earlier request finally answers with older numbers.
  await act(async () => slow.resolve(stats(10)));
  expect(rate()).toHaveTextContent("50%");
});

test("a successful write refreshes the view, and a failed refresh clears old values", async () => {
  vi.mocked(getHabitStatistics).mockReset();
  vi.mocked(getHabitStatistics).mockResolvedValueOnce(stats(20));
  render(<HabitDashboard reload={0} />);
  await showsRate("20%");
  expect(getHabitStatistics).toHaveBeenCalledTimes(1);

  // Another view completes a habit: this one reads again.
  vi.mocked(getHabitStatistics).mockResolvedValueOnce(stats(30));
  act(() => publish(["habits"]));
  await showsRate("30%");
  expect(getHabitStatistics).toHaveBeenCalledTimes(2);

  // A change to something it does not read leaves it alone.
  act(() => publish(["issues"]));
  expect(getHabitStatistics).toHaveBeenCalledTimes(2);

  // The refresh after the next change fails: no stale 30% beside the error.
  vi.mocked(getHabitStatistics).mockRejectedValueOnce({
    code: "storage_failed",
  });
  act(() => publish(["habits"]));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(screen.queryByText("Completion rate")).toBeNull();
  // Retry recovers.
  vi.mocked(getHabitStatistics).mockResolvedValueOnce(stats(40));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await showsRate("40%");
});
