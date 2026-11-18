import type { Habit } from "../../database/habits";
import type { LibraryDocument } from "../../database/documentLibrary";
import type { Project } from "../../database/projects";

/**
 * Pure selection and ordering for the Home sections, so what Home shows is
 * bounded and in a fixed order whatever order the sources return.
 */
export const LIMIT = 5;

/** Habits that can be completed on `today`, in their saved order. */
export function habitsDue(habits: readonly Habit[], today: string): Habit[] {
  return habits
    .filter(
      (habit) =>
        habit.startDate <= today &&
        (habit.archivedOn === null || habit.archivedOn >= today),
    )
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * Documents most recently opened, falling back to when they were last
 * changed for ones never opened. Archived documents are left out; ties break
 * by ID, so the order never flips between visits.
 */
export function recentDocuments(
  documents: readonly LibraryDocument[],
  limit = LIMIT,
): LibraryDocument[] {
  const seen = (doc: LibraryDocument) => doc.openedAt ?? doc.updatedAt;
  return documents
    .filter((doc) => doc.archivedAt === null)
    .sort((a, b) => seen(b).localeCompare(seen(a)) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Active projects, most recently changed first. */
export function activeProjects(
  projects: readonly Project[],
  limit = LIMIT,
): Project[] {
  return projects
    .filter((project) => project.status === "active")
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}
