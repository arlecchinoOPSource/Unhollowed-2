import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { updateDocument } from "../../src/database/documents";
import { getAppVersion } from "../../src/database/updates";
import {
  flushDocumentWrites,
  journalDraft,
} from "../../src/features/documents/editor/drafts";
import { UpdateNotice } from "../../src/features/updates/UpdateNotice";
import { rememberUpdate } from "../../src/features/updates/resume";

vi.mock("../../src/database/status", () => ({ isTauri: () => true }));
vi.mock("../../src/database/updates", () => ({ getAppVersion: vi.fn() }));
vi.mock("../../src/database/documents", () => ({ updateDocument: vi.fn() }));

// U2-P7-06: what happens on the first start after an update's restart.
function start() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <UpdateNotice />
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route path="/issues" element={<p>Issues page</p>} />
        <Route path="/updates" element={<p>Updates page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getAppVersion).mockReset();
});
afterEach(cleanup);

describe("after an update restart", () => {
  test("confirms the installed version and returns to the previous page", async () => {
    rememberUpdate({ version: "1.1.0-beta.1", path: "/issues" });
    vi.mocked(getAppVersion).mockResolvedValue("1.1.0-beta.1");
    start();
    expect(await screen.findByText("Unhollowed is up to date.")).toBeVisible();
    expect(
      screen.getByText(/Version 1\.1\.0-beta\.1 is installed/),
    ).toBeVisible();
    expect(await screen.findByText("Issues page")).toBeVisible();
  });

  test("reports an unfinished update when the version did not change", async () => {
    rememberUpdate({ version: "1.1.0-beta.1", path: "/issues" });
    vi.mocked(getAppVersion).mockResolvedValue("1.0.0-beta.1");
    start();
    expect(
      await screen.findByText("The update to 1.1.0-beta.1 did not finish."),
    ).toBeVisible();
    expect(screen.queryByText("Unhollowed is up to date.")).toBeNull();
    expect(screen.getByText("Home page")).toBeVisible();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/updates",
    );
  });

  test("uses the record once, and does nothing without one", async () => {
    rememberUpdate({ version: "1.1.0-beta.1", path: "/" });
    vi.mocked(getAppVersion).mockResolvedValue("1.1.0-beta.1");
    start();
    await screen.findByText("Unhollowed is up to date.");
    expect(localStorage.getItem("unhollowed-2-update-resume")).toBeNull();
    cleanup();
    vi.mocked(getAppVersion).mockClear();
    start();
    expect(screen.queryByRole("status")).toBeNull();
    expect(getAppVersion).not.toHaveBeenCalled();
  });

  test("ignores a malformed record", () => {
    localStorage.setItem(
      "unhollowed-2-update-resume",
      JSON.stringify({ version: "1.1.0", path: "https://example.com" }),
    );
    start();
    expect(getAppVersion).not.toHaveBeenCalled();
    expect(localStorage.getItem("unhollowed-2-update-resume")).toBeNull();
  });
});

describe("flushing document writes before installing", () => {
  test("saves unsaved drafts and waits for them", async () => {
    vi.mocked(updateDocument).mockResolvedValue({} as never);
    journalDraft("doc-1", { title: "Plan", content: "{}" });
    await flushDocumentWrites();
    expect(updateDocument).toHaveBeenCalledWith("doc-1", "Plan", "{}");
  });

  test("rejects when a draft cannot be saved", async () => {
    vi.mocked(updateDocument).mockRejectedValue({ code: "storage_failed" });
    journalDraft("doc-2", { title: "Notes", content: "{}" });
    await expect(flushDocumentWrites()).rejects.toEqual({
      code: "storage_failed",
    });
  });
});
