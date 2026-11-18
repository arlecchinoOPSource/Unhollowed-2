import { expect, test } from "vitest";
import type { Habit } from "../../src/database/habits";
import type { LibraryDocument } from "../../src/database/documentLibrary";
import type { Project } from "../../src/database/projects";
import {
  activeProjects,
  habitsDue,
  LIMIT,
  recentDocuments,
} from "../../src/features/home/homeData";

const doc = (
  id: string,
  over: Partial<LibraryDocument> = {},
): LibraryDocument =>
  ({
    id,
    title: id,
    updatedAt: "2026-11-01T00:00:00Z",
    openedAt: null,
    archivedAt: null,
    folderId: null,
    favorite: false,
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  }) as LibraryDocument;

test("recent documents: last opened first, changed time for the never opened", () => {
  const list = recentDocuments([
    doc("a", { openedAt: "2026-11-10T09:00:00Z" }),
    doc("b", { openedAt: "2026-11-12T09:00:00Z" }),
    doc("c", { updatedAt: "2026-11-11T09:00:00Z" }),
  ]);
  expect(list.map((d) => d.id)).toEqual(["b", "c", "a"]);
});

test("archived documents are left out, ties break by ID, and the list is bounded", () => {
  const same = "2026-11-12T09:00:00Z";
  const docs = [
    ...["f", "e", "d", "c", "b", "a"].map((id) => doc(id, { openedAt: same })),
    doc("hidden", { openedAt: "2026-11-30T00:00:00Z", archivedAt: same }),
  ];
  const list = recentDocuments(docs);
  expect(list.map((d) => d.id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(list).toHaveLength(LIMIT);
  // Input order never changes the result.
  expect(recentDocuments([...docs].reverse()).map((d) => d.id)).toEqual(
    list.map((d) => d.id),
  );
});

const project = (id: string, status: string, updatedAt: string) =>
  ({ id, name: id, status, updatedAt }) as unknown as Project;

test("active projects only, most recently changed first", () => {
  const list = activeProjects([
    project("old", "active", "2026-11-01T00:00:00Z"),
    project("done", "completed", "2026-11-20T00:00:00Z"),
    project("held", "on_hold", "2026-11-20T00:00:00Z"),
    project("new", "active", "2026-11-10T00:00:00Z"),
    project("gone", "archived", "2026-11-25T00:00:00Z"),
  ]);
  expect(list.map((p) => p.id)).toEqual(["new", "old"]);
});

const habit = (id: string, start: string, end: string | null, position = 0) =>
  ({ id, name: id, position, startDate: start, archivedOn: end }) as Habit;

test("habits due today: started, not ended before today, in saved order", () => {
  const list = habitsDue(
    [
      habit("later", "2026-11-20", null),
      habit("ended", "2026-11-01", "2026-11-16"),
      habit("lastday", "2026-11-01", "2026-11-17", 2),
      habit("walk", "2026-11-01", null, 1),
    ],
    "2026-11-17",
  );
  expect(list.map((h) => h.id)).toEqual(["walk", "lastday"]);
});
