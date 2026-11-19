import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Settings } from "../../src/features/settings/Settings";
import { readDatabaseStatus } from "../../src/database/status";

vi.mock("../../src/database/status", () => ({
  isTauri: () => true,
  readDatabaseStatus: vi.fn(),
}));
vi.mock("../../src/database/updates", () => ({
  getAppVersion: () => Promise.resolve("1.0.0-beta.1"),
}));

afterEach(cleanup);

test("reports a successful workspace read", async () => {
  vi.mocked(readDatabaseStatus).mockResolvedValue({
    workspaceId: "test",
    workspaceName: "Personal",
  });
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Check local storage" }));
  expect(await screen.findByText(/SQLite is ready.*Personal/)).toBeVisible();
});

test("reports a failed workspace read and allows retry", async () => {
  vi.mocked(readDatabaseStatus).mockRejectedValue({
    code: "workspace_read_failed",
  });
  render(<Settings />);
  const button = screen.getByRole("button", { name: "Check local storage" });
  fireEvent.click(button);
  expect(await screen.findByText(/Could not read the workspace/)).toBeVisible();
  expect(button).toBeEnabled();
});

test("shows the installed version under About (U2-P7-04)", async () => {
  render(<Settings />);
  expect(await screen.findByText("Unhollowed 1.0.0-beta.1")).toBeVisible();
});
