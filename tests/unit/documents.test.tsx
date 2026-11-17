import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDocument } from "../../src/database/documents";
import {
  addLibraryDocument,
  loadLibrary,
  updateLibraryDocument,
} from "../../src/database/documentLibrary";
import { isTauri } from "../../src/database/status";
import { Documents } from "../../src/features/documents/Documents";

vi.mock("../../src/database/status", () => ({
  isTauri: vi.fn(),
  readDatabaseStatus: vi.fn(),
}));
vi.mock("../../src/database/documentLinks", () => ({
  getDocumentUsage: vi.fn(() => Promise.resolve({ issues: [], projects: [] })),
}));
vi.mock("../../src/database/documents", () => ({
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
}));
vi.mock("../../src/database/documentLibrary", () => ({
  loadLibrary: vi.fn(),
  addLibraryDocument: vi.fn(),
  updateLibraryDocument: vi.fn(),
}));

const content = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", marks: [{ type: "bold" }], text: "Kept" }],
    },
  ],
});
const stored = {
  id: "doc-1",
  folderId: null,
  favorite: false,
  archivedAt: null,
  openedAt: null,
  title: "Trip notes",
  content,
  createdAt: "2026-11-14T10:00:00.000Z",
  updatedAt: "2026-11-14T10:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(updateLibraryDocument).mockResolvedValue(stored);
});
afterEach(cleanup);

test("explains that documents need the desktop app in the browser", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  render(
    <MemoryRouter>
      <Documents />
    </MemoryRouter>,
  );
  expect(screen.getByRole("heading", { name: "Documents" })).toBeVisible();
  expect(screen.getByText(/stored locally in the desktop app/)).toBeVisible();
  expect(loadLibrary).not.toHaveBeenCalled();
});

test("lists saved documents and reopens one with its formatting", async () => {
  vi.mocked(loadLibrary).mockResolvedValue({
    documents: [stored],
    folders: [],
  });
  vi.mocked(getDocument).mockResolvedValue(stored);
  render(
    <MemoryRouter>
      <Documents />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Trip notes" }));
  expect(await screen.findByLabelText("Document title")).toHaveValue(
    "Trip notes",
  );
  const bold = await screen.findByText("Kept");
  expect(bold.tagName).toBe("STRONG");
});

test("creates a document and opens it in the editor", async () => {
  vi.mocked(loadLibrary).mockResolvedValue({ documents: [], folders: [] });
  vi.mocked(addLibraryDocument).mockResolvedValue({
    ...stored,
    id: "doc-2",
    title: "Untitled",
  });
  vi.mocked(getDocument).mockResolvedValue({
    ...stored,
    id: "doc-2",
    title: "Untitled",
    content: '{"type":"doc","content":[{"type":"paragraph"}]}',
  });
  render(
    <MemoryRouter>
      <Documents />
    </MemoryRouter>,
  );
  expect(await screen.findByText("No documents yet.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /New document/ }));
  expect(await screen.findByLabelText("Document title")).toHaveValue(
    "Untitled",
  );
  expect(screen.getByRole("button", { name: "Untitled" })).toBeVisible();
});

test("reports a failed creation", async () => {
  vi.mocked(loadLibrary).mockResolvedValue({ documents: [], folders: [] });
  vi.mocked(addLibraryDocument).mockRejectedValue({ code: "storage_failed" });
  render(
    <MemoryRouter>
      <Documents />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /New document/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not update the document library.",
  );
});
