import { expect, test } from "vitest";
import {
  eventParam,
  isDay,
  isRecordId,
  links,
  safeBack,
} from "../../src/app/links";

const id = "0b7e6c2a-4f1d-4a55-9a73-5d2f6a9c1e10";

test("record IDs are plain tokens, never paths", () => {
  expect(isRecordId(id)).toBe(true);
  expect(isRecordId("doc-1")).toBe(true);
  for (const bad of [
    "",
    "../x",
    `${id}/x`,
    `${id}?a=1`,
    "a b",
    "x".repeat(65),
    null,
    5,
  ])
    expect(isRecordId(bad)).toBe(false);
});

test("days must be real calendar days", () => {
  expect(isDay("2026-02-28")).toBe(true);
  for (const bad of ["2026-02-30", "2026-13-01", "1800-01-01", "26-1-1", ""])
    expect(isDay(bad)).toBe(false);
});

test("each record type has a path on the existing routes", () => {
  expect(links.issue(id)).toBe(`/issues/${id}`);
  expect(links.project(id)).toBe(`/projects/${id}`);
  expect(links.projectIssues(id)).toBe(`/projects/${id}/issues`);
  expect(links.projectGoals(id)).toBe(`/projects/${id}/goals`);
  expect(links.document(id)).toBe(`/documents?doc=${id}`);
  expect(links.habit(id)).toBe(`/habits?habit=${id}`);
  expect(links.habit(id, "2026-03-04")).toBe(
    `/habits?habit=${id}&date=2026-03-04`,
  );
  expect(links.calendar("2026-03-04")).toBe(
    "/calendar?view=day&date=2026-03-04",
  );
  expect(links.event(id, "2026-03-04")).toBe(
    `/calendar?view=day&date=2026-03-04&event=${id}`,
  );
});

test("an occurrence link lands on the occurrence's own day", () => {
  expect(links.event(id, "2026-03-04", "2026-03-11")).toContain(
    "date=2026-03-11",
  );
});

test("builders refuse malformed IDs and dates instead of building a link", () => {
  expect(() => links.issue("1/../../etc")).toThrow();
  expect(() => links.document("a/b")).toThrow();
  expect(() => links.habit(id, "2026-02-30")).toThrow();
  expect(() => links.event(id, "soon")).toThrow();
});

test("back links stay inside the app", () => {
  expect(safeBack("/projects/x/goals", "/issues")).toBe("/projects/x/goals");
  for (const bad of [
    "https://evil.test",
    "//evil.test",
    "javascript:alert(1)",
    "/\\evil",
    undefined,
    7,
    `/${"a".repeat(600)}`,
  ])
    expect(safeBack(bad, "/issues")).toBe("/issues");
});

test("the event parameter is read only when well formed", () => {
  expect(eventParam(new URLSearchParams(`event=${id}`))).toBe(id);
  expect(eventParam(new URLSearchParams("event=../x"))).toBeNull();
  expect(eventParam(new URLSearchParams(""))).toBeNull();
});
