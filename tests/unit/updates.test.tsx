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
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  type DownloadEvent,
  type DownloadResult,
  type UpdateCheck,
} from "../../src/database/updates";
import { UpdateButton } from "../../src/features/updates/UpdateButton";
import { Updates } from "../../src/features/updates/Updates";
import { useUpdates } from "../../src/features/updates/updateStore";
import { flushDocumentWrites } from "../../src/features/documents/editor/drafts";

vi.mock("../../src/database/updates", () => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  getAppVersion: vi.fn(),
}));
vi.mock("../../src/features/documents/editor/drafts", () => ({
  flushDocumentWrites: vi.fn(() => Promise.resolve()),
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

/** The state title, whose ellipsis is split across elements. */
const findTitle = (text: string) =>
  screen.findByText(
    (_, element) =>
      element?.classList.contains("updates-title") === true &&
      element.textContent === text,
  );

/** A check that answers only when released, to observe the checking state. */
function pending() {
  let release!: (result: UpdateCheck) => void;
  vi.mocked(checkForUpdate).mockReturnValue(
    new Promise((resolve) => (release = resolve)),
  );
  return (result: UpdateCheck) => act(async () => release(result));
}

beforeEach(() => {
  localStorage.clear();
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
  expect(await findTitle("Checking...")).toBeVisible();
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

// U2-P7-05: download progress from real byte counts.
const offer = {
  status: "available" as const,
  currentVersion: "1.0.0-beta.1",
  version: "1.1.0-beta.1",
  date: null,
  notes: null,
};

/** A download that sends `events`, then waits until released with a result. */
function downloading(events: DownloadEvent[]) {
  let finish!: (result: DownloadResult) => void;
  vi.mocked(downloadUpdate).mockImplementation((onEvent) => {
    for (const event of events) onEvent(event);
    return new Promise((resolve) => (finish = resolve));
  });
  return (result: DownloadResult) => act(async () => finish(result));
}

async function openOffer() {
  vi.mocked(checkForUpdate).mockResolvedValueOnce(offer);
  app();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  return screen.findByRole("button", { name: "Download and install" });
}

test("a known total shows a byte-driven percentage", async () => {
  vi.mocked(downloadUpdate).mockReset();
  const finish = downloading([
    { event: "progress", downloaded: 2 * 1024 * 1024, total: 8 * 1024 * 1024 },
  ]);
  fireEvent.click(await openOffer());
  expect(await findTitle("Downloading update...")).toBeVisible();
  const bar = screen.getByRole("progressbar", { name: "Download progress" });
  expect(bar).toHaveAttribute("aria-valuenow", "25");
  expect(screen.getByText("25% · 2 MB of 8 MB")).toBeVisible();
  await finish({ status: "failed", reason: "offline", detail: "x" });
  expect(screen.getByText("Could not reach the update server")).toBeVisible();
});

test.each([
  ["missing", null],
  ["zero", 0],
])(
  "a %s total shows an indeterminate bar and no percentage",
  async (_, total) => {
    vi.mocked(downloadUpdate).mockReset();
    const finish = downloading([
      {
        event: "progress",
        downloaded: 512 * 1024,
        total: total as number | null,
      },
    ]);
    fireEvent.click(await openOffer());
    const bar = await screen.findByRole("progressbar", {
      name: "Download progress",
    });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveClass("is-indeterminate");
    expect(screen.getByText("512 KB downloaded")).toBeVisible();
    expect(screen.queryByText(/%/)).toBeNull();
    await finish({ status: "busy" });
  },
);

test("a finished download is verified, and a bad signature is reported", async () => {
  vi.mocked(downloadUpdate).mockReset();
  const finish = downloading([
    { event: "progress", downloaded: 10, total: 10 },
    { event: "finished" },
  ]);
  fireEvent.click(await openOffer());
  expect(await findTitle("Verifying update...")).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  await finish({ status: "failed", reason: "verification", detail: "x" });
  expect(screen.getByText("The update could not be verified")).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

// U2-P7-06: installation after a verified download.
const RESUME = "unhollowed-2-update-resume";

test("a verified package saves documents, records the return page, and installs", async () => {
  vi.mocked(downloadUpdate).mockReset();
  let restarting!: () => void;
  vi.mocked(installUpdate).mockImplementation((onEvent) => {
    restarting = () => onEvent({ event: "installed" });
    return new Promise(() => {});
  });
  const finish = downloading([{ event: "finished" }]);
  const offerButton = await openOffer();
  // As if the updater had been opened from a filtered issue list.
  useUpdates.setState({ returnTo: "/issues?state=all" });
  fireEvent.click(offerButton);
  await finish({ status: "verified" });
  expect(flushDocumentWrites).toHaveBeenCalledTimes(1);
  expect(installUpdate).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem(RESUME) ?? "null")).toEqual({
    version: "1.1.0-beta.1",
    path: "/issues?state=all",
  });
  expect(await findTitle("Installing update...")).toBeVisible();
  await act(async () => restarting());
  expect(await findTitle("Restarting Unhollowed...")).toBeVisible();
});

test("a document that cannot be saved stops the installation", async () => {
  vi.mocked(downloadUpdate).mockReset();
  vi.mocked(installUpdate).mockReset();
  vi.mocked(flushDocumentWrites).mockRejectedValueOnce(new Error("disk full"));
  const finish = downloading([{ event: "finished" }]);
  fireEvent.click(await openOffer());
  await finish({ status: "verified" });
  expect(screen.getByText("A document could not be saved")).toBeVisible();
  expect(installUpdate).not.toHaveBeenCalled();
  expect(localStorage.getItem(RESUME)).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a failed installation keeps the app open with recovery steps", async () => {
  vi.mocked(downloadUpdate).mockReset();
  vi.mocked(installUpdate).mockResolvedValueOnce({
    status: "failed",
    reason: "install",
    detail: "permission denied",
  });
  const finish = downloading([{ event: "finished" }]);
  fireEvent.click(await openOffer());
  await finish({ status: "verified" });
  expect(screen.getByText("The update could not be installed")).toBeVisible();
  expect(
    screen.getByText(/releases page and run it over this version/),
  ).toBeVisible();
  expect(localStorage.getItem(RESUME)).toBeNull();
  expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
});

test("repeated activation starts one download, and leaving is not offered mid-download", async () => {
  vi.mocked(downloadUpdate).mockReset();
  const finish = downloading([]);
  const button = await openOffer();
  fireEvent.click(button);
  expect(
    screen.queryByRole("button", { name: "Download and install" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(downloadUpdate).toHaveBeenCalledTimes(1);
  expect(checkForUpdate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  await finish({ status: "busy" });
});
