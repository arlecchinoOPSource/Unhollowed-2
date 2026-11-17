import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryIssues,
  setIssueDueDate,
  type IssueSummary,
} from "../../src/database/issues";
import { OverdueIssues } from "../../src/features/calendar/OverdueIssues";

vi.mock("../../src/database/issues", async (original) => ({
  ...(await original<typeof import("../../src/database/issues")>()),
  queryIssues: vi.fn(),
  setIssueDueDate: vi.fn(),
}));
vi.mock("../../src/features/today/useLocalToday", () => ({
  useLocalToday: () => "2026-11-17",
}));

function issue(number: number, dueDate: string): IssueSummary {
  return {
    id: `i${number}`,
    number,
    projectId: null,
    title: `Late ${number}`,
    status: "todo",
    priority: "none",
    startDate: null,
    dueDate,
    completedAt: null,
    closed: false,
    createdAt: "",
    updatedAt: "",
    milestoneId: null,
    recurrenceId: null,
    archivedAt: null,
    recurring: false,
    labelIds: [],
  } as IssueSummary;
}

function show(url = "/calendar", onChanged = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <OverdueIssues revision={0} onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
}

beforeEach(() => {
  vi.mocked(queryIssues).mockResolvedValue({
    issues: [issue(1, "2026-11-10")],
    total: 1,
    open: 1,
    closed: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("overdue issues", () => {
  it("lists open issues due before today, honoring the project filter", async () => {
    show("/calendar?project=p1");
    expect(await screen.findByText("Late 1")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(queryIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "open",
        dueBefore: "2026-11-16",
        projectIds: ["p1"],
      }),
    );
  });

  it("shows nothing when no issue is overdue", async () => {
    vi.mocked(queryIssues).mockResolvedValue({
      issues: [],
      total: 0,
      open: 0,
      closed: 0,
    });
    show();
    await waitFor(() => expect(queryIssues).toHaveBeenCalled());
    expect(screen.queryByText(/^Overdue/)).toBeNull();
  });

  it("reschedules through the issue command and reports the change", async () => {
    vi.mocked(setIssueDueDate).mockResolvedValue({
      ...issue(1, "2026-11-20"),
      description: "",
    });
    const onChanged = show();
    const input = await screen.findByLabelText("Due date for ISS-1");
    fireEvent.change(input, { target: { value: "2026-11-20" } });
    fireEvent.blur(input);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(setIssueDueDate).toHaveBeenCalledWith("i1", "2026-11-20");
  });

  it("keeps the issue and says so when rescheduling fails", async () => {
    vi.mocked(setIssueDueDate).mockRejectedValue({ code: "not_found" });
    const onChanged = show();
    const input = await screen.findByLabelText("Due date for ISS-1");
    fireEvent.change(input, { target: { value: "2026-11-20" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
