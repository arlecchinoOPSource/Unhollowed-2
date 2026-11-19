import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { checkForUpdate, type UpdateCheck } from "../../src/database/updates";
import { UpdateButton } from "../../src/features/updates/UpdateButton";
import { Updates } from "../../src/features/updates/Updates";
import { useUpdates } from "../../src/features/updates/updateStore";

vi.mock("../../src/database/updates", () => ({
  checkForUpdate: vi.fn(),
  getAppVersion: vi.fn(),
}));

// U2-P7-04: the sidebar control and the updater screen, against a mocked
// native check.
function app(start = "/") {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <UpdateButton />
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/updates" element={<Updates />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A check that answers only when released, to observe the checking state. */
function pending() {
  let release!: (result: UpdateCheck) => void;
  vi.mocked(checkForUpdate).mockReturnValue(
    new Promise((resolve) => (release = resolve)),
  );
  return (result: UpdateCheck) => act(async () => release(result));
}

beforeEach(() => {
  useUpdates.setState({ state: { phase: "idle" } });
  vi.mocked(checkForUpdate).mockReset();
});
afterEach(cleanup);

test("the sidebar control has an accessible name and a tooltip", () => {
  app();
  const button = screen.getByRole("button", { name: "Check for updates" });
  expect(button).toHaveAttribute("title", "Check for updates");
  expect(button.tagName).toBe("BUTTON");
});

test("opening the updater checks once and reports an up-to-date app", async () => {
  const answer = pending();
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Checking…")).toBeVisible();
  await answer({ status: "current", currentVersion: "1.0.0-beta.1" });
  expect(screen.getByText("Unhollowed is up to date")).toBeVisible();
  expect(screen.getByText(/latest version, 1\.0\.0-beta\.1/)).toBeVisible();
  expect(checkForUpdate).toHaveBeenCalledTimes(1);
});

test("repeated activation cannot start a second operation", async () => {
  const answer = pending();
  app();
  const button = screen.getByRole("button", { name: "Check for updates" });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(checkForUpdate).toHaveBeenCalledTimes(1);
  await answer({ status: "current", currentVersion: "1" });
});

test("rendering the screen does not check by itself", () => {
  app("/updates");
  expect(screen.getByText(/checks only when you ask/)).toBeVisible();
  expect(checkForUpdate).not.toHaveBeenCalled();
});

test("an offline check explains itself and recovers", async () => {
  vi.mocked(checkForUpdate).mockResolvedValueOnce({
    status: "failed",
    reason: "offline",
    detail: "connection refused",
  });
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(
    await screen.findByText("Could not reach the update server"),
  ).toBeVisible();
  expect(screen.getByText(/workspace is not affected/)).toBeVisible();
  vi.mocked(checkForUpdate).mockResolvedValueOnce({
    status: "current",
    currentVersion: "1",
  });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Unhollowed is up to date")).toBeVisible();
});

test("an available update shows its version and notes", async () => {
  vi.mocked(checkForUpdate).mockResolvedValueOnce({
    status: "available",
    currentVersion: "1.0.0-beta.1",
    version: "1.1.0-beta.1",
    date: null,
    notes: "Faster search",
  });
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(
    await screen.findByText("Version 1.1.0-beta.1 is available"),
  ).toBeVisible();
  expect(screen.getByText("Faster search")).toBeVisible();
});

test("an unsupported platform offers no retry but can be closed", async () => {
  vi.mocked(checkForUpdate).mockResolvedValueOnce({
    status: "unsupported",
    target: "linux-x86_64",
  });
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(
    await screen.findByText("Updates are not available here"),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
});

test("Done leaves the screen and returns focus to the sidebar control", async () => {
  vi.mocked(checkForUpdate).mockResolvedValueOnce({
    status: "current",
    currentVersion: "1",
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  expect(await screen.findByText("Home page")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Check for updates" }),
  ).toHaveFocus();
  expect(useUpdates.getState().state).toEqual({ phase: "idle" });
});

test("the checking state can be left, because a check changes nothing", async () => {
  const answer = pending();
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByRole("button", { name: "Done" })).toBeVisible();
  await answer({ status: "current", currentVersion: "1" });
});
