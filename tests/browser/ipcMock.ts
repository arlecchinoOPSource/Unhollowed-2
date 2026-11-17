import type { Page } from "@playwright/test";
import type {
  Issue,
  IssueFields,
  IssueQuery,
  IssueStatus,
  RepeatRule,
} from "../../src/database/issues";
import type { ProjectGoals } from "../../src/database/goals";
import type { RelationKind } from "../../src/database/relationships";
import type { Label, LabelInput } from "../../src/database/labels";
import type { Calendar, CalendarInput } from "../../src/database/calendars";
import type {
  CalendarEvent,
  CalendarItem,
  EventInput,
} from "../../src/database/events";
import type { SavedView, ViewConfig } from "../../src/database/savedViews";
import type { Milestone, MilestoneInput } from "../../src/database/milestones";
import type { Project } from "../../src/database/projects";

/**
 * Replaces Tauri IPC in the page with an in-memory backend that follows the
 * backend's lifecycle rules. Rust tests cover SQLite and the real commands.
 * Tests seed data with `window.__seedIssues`, `__seedViews`, and
 * `__seedDocuments`, and drive failures and delays with window events.
 */
export async function installIpcMock(page: Page) {
  await page.addInitScript(() => {
    const empty = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const projects: Project[] = [
      {
        id: "project-1",
        name: "Studio launch",
        description: null,
        status: "active",
        startDate: null,
        targetDate: null,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
      },
      {
        id: "project-2",
        name: "Garden",
        description: null,
        status: "active",
        startDate: null,
        targetDate: null,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
      },
    ];
    // Tests can preload issues by defining window.__seedIssues in their own
    // init script. That script runs after this one, so seeds load on the
    // first IPC call.
    const issues: Issue[] = [];
    const labels: Label[] = [];
    // Calendars follow the backend: one active default, created on first
    // use, unique names, and archiving the default needs a replacement.
    const calendars: Calendar[] = [];
    const calendarDefault = () => {
      let found = calendars.find(({ isDefault }) => isDefault);
      if (!found) {
        found = {
          id: "calendar-personal",
          name: "Personal",
          description: null,
          color: "blue",
          isDefault: true,
          hidden: false,
          archivedAt: null,
          createdAt: "2026-11-16T00:00:00Z",
          updatedAt: "2026-11-16T00:00:00Z",
        };
        calendars.push(found);
      }
      return found;
    };
    // Events, stored like the backend: all-day with an exclusive end date,
    // timed with wall-clock times. The browser tests use one zone, so a
    // viewer sees timed events at the times they were entered.
    const events: CalendarEvent[] = [];
    const workBlocks: {
      id: string;
      issueId: string;
      timeZone: string;
      startLocal: string;
      endLocal: string;
      startAt: string;
      endAt: string;
      createdAt: string;
      updatedAt: string;
    }[] = [];
    const seededEvents = () => {
      const seeds = (
        window as unknown as { __seedEvents?: Partial<CalendarEvent>[] }
      ).__seedEvents;
      if (seeds && !events.length)
        for (const [index, seed] of seeds.entries())
          events.push({
            id: `event-${index + 1}`,
            calendarId: calendarDefault().id,
            title: `Event ${index + 1}`,
            description: "",
            location: null,
            url: null,
            allDay: false,
            startDate: null,
            endDate: null,
            timeZone: "Europe/Paris",
            startLocal: null,
            endLocal: null,
            startAt: null,
            endAt: null,
            repeatFreq: null,
            repeatInterval: null,
            repeatCount: null,
            repeatUntil: null,
            createdAt: "2026-11-16T00:00:00Z",
            updatedAt: "2026-11-16T00:00:00Z",
            ...seed,
          });
    };
    const findEvent = (id?: string) => {
      seededEvents();
      const found = events.find((item) => item.id === id);
      if (!found) throw { code: "not_found" };
      return found;
    };
    // Occurrence changes, keyed `${eventId}|${occurrence}`.
    const changes = new Map<
      string,
      { canceled: boolean; title?: string; start?: string; end?: string }
    >();
    const shiftDays = (date: string, days: number) => {
      const day = new Date(`${date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + days);
      return day.toISOString().slice(0, 10);
    };
    const shiftMinutes = (local: string, minutes: number) =>
      new Date(Date.parse(`${local}:00Z`) + minutes * 60_000)
        .toISOString()
        .slice(0, 16);
    /** A small version of the backend's expansion for daily, weekly, and
     * monthly rules, with count and until limits. */
    const occurrencesOf = (event: CalendarEvent, from: string, to: string) => {
      const first = event.allDay ? event.startDate! : event.startLocal!;
      const time = event.allDay ? "" : first.slice(10);
      const length = event.allDay
        ? (Date.parse(event.endDate!) - Date.parse(event.startDate!)) / 60_000
        : (Date.parse(`${event.endLocal}:00Z`) -
            Date.parse(`${event.startLocal}:00Z`)) /
          60_000;
      const found: {
        key: string;
        start: string;
        end: string;
        title: string;
      }[] = [];
      let ordinal = 0;
      for (let n = 0; n < 1000; n += 1) {
        const step = n * (event.repeatInterval ?? 1);
        let day = first.slice(0, 10);
        if (event.repeatFreq === "daily") day = shiftDays(day, step);
        else if (event.repeatFreq === "weekly") day = shiftDays(day, step * 7);
        else {
          const date = new Date(`${day}T00:00:00Z`);
          const months = event.repeatFreq === "yearly" ? step * 12 : step;
          const target = new Date(
            Date.UTC(
              date.getUTCFullYear(),
              date.getUTCMonth() + months,
              date.getUTCDate(),
            ),
          );
          if (target.getUTCDate() !== date.getUTCDate()) continue;
          day = target.toISOString().slice(0, 10);
        }
        if (event.repeatCount !== null && ordinal >= event.repeatCount) break;
        if (event.repeatUntil && day > event.repeatUntil) break;
        ordinal += 1;
        if (day >= to) break;
        const key = event.allDay ? day : `${day}${time}`;
        const change = changes.get(`${event.id}|${key}`);
        if (change?.canceled) continue;
        found.push({
          key,
          start: change?.start ?? key,
          end:
            change?.end ??
            (event.allDay
              ? shiftDays(day, length / 1440)
              : shiftMinutes(key, length)),
          title: change?.title ?? event.title,
        });
      }
      return found.filter(({ start, end }) => start < to && end > from);
    };
    const eventFields = (input: EventInput) => {
      if (!input.title.trim()) throw { code: "invalid_title" };
      if (input.url && !/^https?:\/\/[a-z0-9.[\]:-]+/i.test(input.url))
        throw { code: "invalid_url" };
      if (input.allDay) {
        if (
          !input.startDate ||
          !input.endDate ||
          input.endDate <= input.startDate
        )
          throw { code: "invalid_range" };
      } else if (!input.start || !input.end || input.end <= input.start)
        throw { code: "invalid_range" };
      return {
        title: input.title.trim(),
        description: input.description,
        location: input.location?.trim() || null,
        url: input.url?.trim() || null,
        allDay: input.allDay,
        startDate: input.allDay ? input.startDate! : null,
        endDate: input.allDay ? input.endDate! : null,
        timeZone: input.allDay ? null : input.timeZone!,
        startLocal: input.allDay ? null : input.start!,
        endLocal: input.allDay ? null : input.end!,
        startAt: null,
        endAt: null,
        repeatFreq: input.repeat?.freq ?? null,
        repeatInterval: input.repeat?.interval ?? null,
        repeatCount: input.repeat?.count ?? null,
        repeatUntil: input.repeat?.until ?? null,
      };
    };
    const findCalendar = (id?: string) => {
      const found = calendars.find((item) => item.id === id);
      if (!found) throw { code: "calendar_not_found" };
      return found;
    };
    // Saved views, optionally seeded through window.__seedViews.
    const views: SavedView[] = [];
    // Documents seeded through window.__seedDocuments, and their links.
    const documents: { id: string; title: string; content: string }[] = [];
    function libraryDocument(document: (typeof documents)[number]) {
      return {
        ...document,
        folderId: null,
        favorite: false,
        archivedAt: null,
        openedAt: null,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
      };
    }

    let remindersOn = true;
    const eventReminders = new Map<string, number>();
    const eventDocuments: [string, string][] = [];
    const eventProjects: [string, string][] = [];
    const issueDocuments: [string, string][] = [];
    const projectDocuments: [string, string][] = [];
    const milestones: Milestone[] = [];
    const goals: ProjectGoals = { missions: [], objectives: [], links: [] };
    const relationships: { child: string; parent: string }[] = [];
    let seeded = false;
    const seed = () =>
      (
        (window as unknown as { __seedIssues?: Partial<Issue>[] })
          .__seedIssues ?? []
      ).map((seed, index): Issue => ({
        id: `seed-${index + 1}`,
        number: index + 1,
        projectId: null,
        title: `Seed ${index + 1}`,
        description: empty,
        status: "todo",
        priority: "none",
        startDate: null,
        dueDate: null,
        completedAt: null,
        closed: seed.status === "done" || seed.status === "canceled",
        createdAt: `2026-11-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        updatedAt: `2026-11-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
        labelIds: [],
        milestoneId: null,
        recurrenceId: null,
        recurring: false,
        archivedAt: null,
        ...seed,
      }));
    let clock = 0;
    let delayedList: Promise<void> | undefined;
    if (location.search.includes("delay-list")) {
      delayedList = new Promise((resolve) => {
        window.addEventListener("release-list", () => resolve(), {
          once: true,
        });
      });
    }
    const failing = new Set<string>();
    // Failures last until cleared, because React's development StrictMode
    // runs each load effect twice.
    window.addEventListener("fail-command", (event) => {
      failing.add((event as CustomEvent<string>).detail);
    });
    // One-shot failures and held commands, for testing overlapping writes.
    const failOnce = new Set<string>();
    window.addEventListener("fail-once", (event) => {
      failOnce.add((event as CustomEvent<string>).detail);
    });
    const held = new Map<string, Promise<void>>();
    window.addEventListener("hold-command", (event) => {
      const command = (event as CustomEvent<string>).detail;
      held.set(
        command,
        new Promise((resolve) =>
          window.addEventListener(`release-${command}`, () => resolve(), {
            once: true,
          }),
        ),
      );
    });
    window.addEventListener("restore-command", (event) => {
      failing.delete((event as CustomEvent<string>).detail);
    });
    const now = () =>
      new Date(Date.UTC(2026, 10, 16, 0, 0, clock++)).toISOString();
    const find = (id?: string) => {
      const issue = issues.find((item) => item.id === id);
      if (!issue) throw { code: "not_found" };
      return issue;
    };
    // Recurring series, following the backend rules: dates come from the
    // anchor, missed dates are skipped, and only one next occurrence exists.
    const series = new Map<
      string,
      {
        frequency: RepeatRule["frequency"];
        interval: number;
        anchor: string;
        stopped: boolean;
      }
    >();
    const occurrence = new Map<string, number>();
    const dayMs = 86_400_000;
    const occurrenceDate = (id: string, index: number) => {
      const rule = series.get(id)!;
      const [y, m, d] = rule.anchor.split("-").map(Number);
      let date: Date;
      if (rule.frequency === "monthly") {
        const months = m - 1 + index * rule.interval;
        const last = new Date(Date.UTC(y, months + 1, 0)).getUTCDate();
        date = new Date(Date.UTC(y, months, Math.min(d, last)));
      } else {
        const step = rule.frequency === "weekly" ? 7 : 1;
        date = new Date(
          Date.UTC(y, m - 1, d) + index * rule.interval * step * dayMs,
        );
      }
      return date.toISOString().slice(0, 10);
    };
    const advance = (issue: Issue, today?: string) => {
      const id = issue.recurrenceId;
      if (!id || series.get(id)?.stopped) return;
      const index = occurrence.get(issue.id) ?? 0;
      const later = issues.some(
        (other) =>
          other.recurrenceId === id && (occurrence.get(other.id) ?? 0) > index,
      );
      if (later) return;
      let next = index + 1;
      while (today && occurrenceDate(id, next) < today) next += 1;
      const time = now();
      const created: Issue = {
        ...structuredClone(issue),
        id: `issue-${issues.length + 1}`,
        number: issues.length + 1,
        status: "todo",
        closed: false,
        completedAt: null,
        dueDate: occurrenceDate(id, next),
        createdAt: time,
        updatedAt: time,
      };
      occurrence.set(created.id, next);
      issues.push(created);
    };
    const setStatus = (issue: Issue, status: IssueStatus, today?: string) => {
      if (issue.status === status) return issue;
      const wasClosed = issue.closed;
      issue.status = status;
      issue.closed = status === "done" || status === "canceled";
      issue.completedAt =
        status === "done" ? (issue.completedAt ?? now()) : null;
      issue.updatedAt = now();
      if (!wasClosed && issue.closed) advance(issue, today);
      return issue;
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (
          command: string,
          args: {
            id?: string;
            input?: IssueFields;
            projectId?: string | null;
            status?: IssueStatus;
            query?: IssueQuery;
            labelIds?: string[];
            milestoneId?: string | null;
            otherId?: string;
            kind?: RelationKind;
            today?: string;
            rule?: RepeatRule | null;
          } = {},
        ) => {
          if (!seeded) {
            seeded = true;
            issues.push(...seed());
            views.push(
              ...((window as unknown as { __seedViews?: SavedView[] })
                .__seedViews ?? []),
            );
            documents.push(
              ...(
                (window as unknown as { __seedDocuments?: string[] })
                  .__seedDocuments ?? []
              ).map((title, index) => ({
                id: `doc-${index + 1}`,
                title,
                content: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: `${title} body` }],
                    },
                  ],
                }),
              })),
            );
          }
          const hold = held.get(command);
          if (hold) {
            held.delete(command);
            await hold;
          }
          if (failing.has(command)) throw { code: "storage_failed" };
          if (failOnce.delete(command)) throw { code: "storage_failed" };
          switch (command) {
            case "list_projects":
              return projects;
            case "get_project": {
              const project = projects.find((item) => item.id === args.id);
              if (!project) throw { code: "not_found" };
              return project;
            }
            case "list_project_goals": {
              // Rollups as in the backend: each issue counted once per group.
              const rollup = (ids: Set<string>) => {
                const linked = [...ids].map((id) => find(id));
                const count = (test: (issue: Issue) => boolean) =>
                  linked.filter(test).length;
                return {
                  total: count((issue) => issue.status !== "canceled"),
                  completed: count((issue) => issue.status === "done"),
                  blocked: count((issue) => issue.status === "blocked"),
                  canceled: count((issue) => issue.status === "canceled"),
                };
              };
              const members = (objectiveIds: string[]) =>
                new Set(
                  goals.links
                    .filter(([id]) => objectiveIds.includes(id))
                    .map(([, id]) => id),
                );
              return structuredClone({
                ...goals,
                missions: goals.missions.map((mission) => ({
                  ...mission,
                  ...rollup(
                    members(
                      goals.objectives
                        .filter(
                          (objective) => objective.missionId === mission.id,
                        )
                        .map(({ id }) => id),
                    ),
                  ),
                })),
                objectives: goals.objectives.map((objective) => ({
                  ...objective,
                  ...rollup(members([objective.id])),
                })),
              });
            }
            case "save_project_mission": {
              const input = args.input as unknown as {
                title: string;
                description: string;
              };
              goals.missions.push({
                id: "sample-mission",
                ...input,
                total: 0,
                completed: 0,
                blocked: 0,
                canceled: 0,
              });
              return;
            }
            case "save_project_objective": {
              const { issueIds, ...input } = args.input as unknown as {
                title: string;
                description: string;
                missionId: string | null;
                issueIds: string[];
              };
              goals.objectives.push({
                id: "sample-objective",
                ...input,
                completed: 0,
                total: 0,
                blocked: 0,
                canceled: 0,
              });
              goals.links.push(
                ...issueIds.map((id): [string, string] => [
                  "sample-objective",
                  id,
                ]),
              );
              return;
            }
            case "list_issues":
              return structuredClone(
                issues.filter(
                  (issue) =>
                    !args.projectId || issue.projectId === args.projectId,
                ),
              );
            case "list_issue_relationships":
              return relationships
                .filter(
                  (edge) => edge.child === args.id || edge.parent === args.id,
                )
                .map((edge) => {
                  const isChild = edge.child === args.id;
                  const { id, title, number, status, archivedAt } = find(
                    isChild ? edge.parent : edge.child,
                  );
                  return {
                    id,
                    title,
                    number,
                    status,
                    archived: Boolean(archivedAt),
                    kind: isChild ? "parent" : "child",
                  };
                });
            case "add_issue_relationship":
              if (args.kind === "child" && args.id && args.otherId) {
                relationships.push({ parent: args.id, child: args.otherId });
                return;
              }
              throw { code: "cycle" };
            case "query_issues": {
              // Mirrors the backend's filter, sort, and paging rules.
              const q = args.query!;
              const text = q.text?.trim().toLowerCase();
              const matches = issues.filter(
                (issue) =>
                  (!text ||
                    `${issue.title}\n${issue.description}`
                      .toLowerCase()
                      .includes(text)) &&
                  (!q.statuses?.length || q.statuses.includes(issue.status)) &&
                  (!q.priorities?.length ||
                    q.priorities.includes(issue.priority)) &&
                  (!(q.projectIds?.length || q.inbox) ||
                    (issue.projectId
                      ? (q.projectIds ?? []).includes(issue.projectId)
                      : Boolean(q.inbox))) &&
                  (q.undated === "only"
                    ? !issue.dueDate
                    : issue.dueDate
                      ? (!q.dueAfter || issue.dueDate >= q.dueAfter) &&
                        (!q.dueBefore || issue.dueDate <= q.dueBefore)
                      : q.undated !== "exclude") &&
                  (!q.labelIds?.length ||
                    (q.labelMatch === "all"
                      ? q.labelIds.every((id) => issue.labelIds.includes(id))
                      : q.labelIds.some((id) =>
                          issue.labelIds.includes(id),
                        ))) &&
                  (!(q.milestoneIds?.length || q.noMilestone) ||
                    (issue.milestoneId
                      ? (q.milestoneIds ?? []).includes(issue.milestoneId)
                      : Boolean(q.noMilestone))) &&
                  (q.archived === "include" ||
                    (q.archived === "only"
                      ? Boolean(issue.archivedAt)
                      : !issue.archivedAt)),
              );
              const open = matches.filter((issue) => !issue.closed).length;
              const inState = matches.filter(
                (issue) =>
                  !q.state ||
                  q.state === "all" ||
                  (q.state === "closed") === issue.closed,
              );
              const rank = ["none", "low", "medium", "high", "urgent"];
              const key = (issue: Issue): string | number =>
                ({
                  updated: issue.updatedAt,
                  created: issue.createdAt,
                  priority: rank.indexOf(issue.priority),
                  title: issue.title.toLowerCase(),
                  due: issue.dueDate ?? "",
                })[q.sort ?? "updated"];
              const sign = q.direction === "asc" ? 1 : -1;
              inState.sort((a, b) => {
                if (q.sort === "due" && !a.dueDate !== !b.dueDate)
                  return a.dueDate ? -1 : 1;
                const [x, y] = [key(a), key(b)];
                return (
                  (x < y ? -sign : x > y ? sign : 0) ||
                  sign * (a.number - b.number)
                );
              });
              const offset = q.offset ?? 0;
              const snapshot = structuredClone({
                issues: inState.slice(offset, offset + (q.limit ?? 100)),
                total: inState.length,
                open,
                closed: matches.length - open,
              });
              await delayedList;
              return snapshot;
            }
            case "list_document_library":
              return { documents: documents.map(libraryDocument), folders: [] };
            case "change_document_library": {
              const document = documents.find((item) => item.id === args.id);
              if (!document) throw { code: "not_found" };
              return libraryDocument(document);
            }
            case "list_document_references":
              return [];
            case "get_document_graph":
              return {
                documents: documents.map(libraryDocument),
                links: [],
                memberships: [],
              };
            case "list_documents":
              return documents.map(({ id, title }) => ({
                id,
                title,
                updatedAt: "2026-11-01T00:00:00Z",
              }));
            case "get_document": {
              const document = documents.find((item) => item.id === args.id);
              if (!document) throw { code: "not_found" };
              return {
                ...document,
                createdAt: "2026-11-01T00:00:00Z",
                updatedAt: "2026-11-01T00:00:00Z",
              };
            }
            case "list_issue_documents":
            case "link_issue_document":
            case "unlink_issue_document":
            case "list_project_documents":
            case "link_project_document":
            case "unlink_project_document": {
              const { issueId, documentId } = args as {
                issueId?: string;
                documentId?: string;
              };
              const forIssue = command.includes("issue");
              const owner = forIssue ? issueId! : args.projectId!;
              const links = forIssue ? issueDocuments : projectDocuments;
              if (forIssue) find(owner);
              if (command.startsWith("link")) {
                if (!documents.some((item) => item.id === documentId))
                  throw { code: "document_not_found" };
                if (!links.some(([o, d]) => o === owner && d === documentId))
                  links.push([owner, documentId!]);
              }
              if (command.startsWith("unlink")) {
                const index = links.findIndex(
                  ([o, d]) => o === owner && d === documentId,
                );
                if (index >= 0) links.splice(index, 1);
              }
              const summary = (id: string) => {
                const document = documents.find((item) => item.id === id)!;
                return {
                  id,
                  title: document.title,
                  updatedAt: "2026-11-01T00:00:00Z",
                };
              };
              const direct = links
                .filter(([o]) => o === owner)
                .map(([, d]) => summary(d))
                .sort((a, b) => a.title.localeCompare(b.title));
              if (forIssue) return direct;
              const viaIssues = documents
                .filter(({ id }) => !direct.some((item) => item.id === id))
                .map(({ id }) => ({
                  ...summary(id),
                  issues: issueDocuments
                    .filter(([, d]) => d === id)
                    .map(([issue]) => issues.find((item) => item.id === issue)!)
                    .filter((issue) => issue.projectId === owner)
                    .map(({ id, number, title }) => ({ id, number, title })),
                }))
                .filter((document) => document.issues.length > 0);
              return { direct, viaIssues };
            }
            case "get_document_usage": {
              const documentId = (args as { documentId: string }).documentId;
              return {
                issues: issueDocuments
                  .filter(([, d]) => d === documentId)
                  .map(([issue]) => issues.find((item) => item.id === issue)!)
                  .map(({ id, number, title }) => ({ id, number, title })),
                projects: projectDocuments
                  .filter(([, d]) => d === documentId)
                  .map(([project]) =>
                    projects.find((item) => item.id === project)!,
                  )
                  .map(({ id, name }) => ({ id, name })),
              };
            }
            case "get_project_overview": {
              // Mirrors the backend aggregates and their denominators.
              const { today } = args as { today: string };
              const project = projects.find(
                (item) => item.id === args.projectId,
              );
              if (!project) throw { code: "not_found" };
              const own = issues.filter(
                (issue) => issue.projectId === project.id,
              );
              const count = (status: IssueStatus) =>
                own.filter((issue) => issue.status === status).length;
              const statuses = {
                todo: count("todo"),
                inProgress: count("in_progress"),
                blocked: count("blocked"),
                done: count("done"),
                canceled: count("canceled"),
              };
              const counted = own.length - statuses.canceled;
              const open = own.filter((issue) => !issue.closed);
              const horizon = new Date(`${today}T00:00:00Z`);
              horizon.setUTCDate(horizon.getUTCDate() + 6);
              const end = horizon.toISOString().slice(0, 10);
              const byDue = (a: Issue, b: Issue) =>
                a.dueDate!.localeCompare(b.dueDate!) || a.number - b.number;
              const overdue = open
                .filter((issue) => issue.dueDate && issue.dueDate < today)
                .sort(byDue);
              const upcoming = open
                .filter(
                  (issue) =>
                    issue.dueDate &&
                    issue.dueDate >= today &&
                    issue.dueDate <= end,
                )
                .sort(byDue);
              const activity = own
                .flatMap((issue) => [
                  { kind: "created", at: issue.createdAt, issue },
                  ...(issue.completedAt
                    ? [{ kind: "completed", at: issue.completedAt, issue }]
                    : []),
                ])
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 10)
                .map(({ kind, at, issue }) => ({
                  kind,
                  at,
                  issueId: issue.id,
                  number: issue.number,
                  title: issue.title,
                }));
              return structuredClone({
                project,
                total: own.length,
                open: open.length,
                closed: own.length - open.length,
                statuses,
                completion: counted > 0 ? statuses.done / counted : null,
                overdueCount: overdue.length,
                overdue: overdue.slice(0, 5),
                upcomingCount: upcoming.length,
                upcoming: upcoming.slice(0, 5),
                undatedOpen: open.filter((issue) => !issue.dueDate).length,
                milestones: [],
                activity,
              });
            }
            case "archive_issue":
            case "restore_issue": {
              const issue = find(args.id);
              issue.archivedAt =
                command === "archive_issue"
                  ? (issue.archivedAt ?? now())
                  : null;
              return structuredClone(issue);
            }
            case "get_issue_deletion_impact":
            case "delete_issue": {
              const issue = find(args.id);
              const subIssues = relationships.filter(
                (edge) => edge.parent === issue.id,
              ).length;
              const impact = {
                key: `ISS-${issue.number}`,
                archived: Boolean(issue.archivedAt),
                labels: issue.labelIds.length,
                documents: issueDocuments.filter(([id]) => id === issue.id)
                  .length,
                objectives: goals.links.filter(([, id]) => id === issue.id)
                  .length,
                workBlocks: workBlocks.filter((b) => b.issueId === issue.id)
                  .length,
                relationships: relationships.filter(
                  (edge) => edge.child === issue.id || edge.parent === issue.id,
                ).length,
                subIssues,
                activeSeries: false,
              };
              if (command === "get_issue_deletion_impact") return impact;
              const confirm = (args as { confirmKey: string }).confirmKey;
              if (confirm.trim().toUpperCase() !== impact.key)
                throw { code: "confirmation_mismatch" };
              if (!impact.archived) throw { code: "not_archived" };
              if (subIssues > 0) throw { code: "has_sub_issues" };
              issues.splice(issues.indexOf(issue), 1);
              for (let index = relationships.length - 1; index >= 0; index--)
                if (
                  relationships[index].child === issue.id ||
                  relationships[index].parent === issue.id
                )
                  relationships.splice(index, 1);
              return null;
            }
            case "search_workspace": {
              const text = (args as { text: string }).text.trim().toLowerCase();
              const number = /^(iss-|#)?(\d+)$/.exec(text)?.[2];
              const matched = issues
                .filter(
                  (issue) =>
                    issue.title.toLowerCase().includes(text) ||
                    String(issue.number) === number,
                )
                .sort(
                  (a, b) =>
                    Number(String(b.number) === number) -
                      Number(String(a.number) === number) ||
                    Number(a.closed) - Number(b.closed),
                );
              const found = projects.filter((project) =>
                project.name.toLowerCase().includes(text),
              );
              const hits = milestones.filter((milestone) =>
                milestone.title.toLowerCase().includes(text),
              );
              const documentHits = documents.filter(
                (item) =>
                  item.title.toLowerCase().includes(text) ||
                  item.content.toLowerCase().includes(text),
              );
              return structuredClone({
                documents: documentHits.slice(0, 8).map(({ id, title }) => ({
                  id,
                  title,
                  preview: `${title} body`,
                })),
                documentTotal: documentHits.length,
                projects: found.slice(0, 8).map(({ id, name, status }) => ({
                  id,
                  name,
                  status,
                })),
                projectTotal: found.length,
                issues: matched.slice(0, 8),
                issueTotal: matched.length,
                milestones: hits.slice(0, 8).map((milestone) => ({
                  id: milestone.id,
                  title: milestone.title,
                  projectId: milestone.projectId,
                  projectName: null,
                  closed: milestone.closed,
                })),
                milestoneTotal: hits.length,
              });
            }
            case "export_project_data":
            case "export_issues_csv": {
              // The native save dialog is not available here, so the mock
              // records the request and reports a fixed path.
              Object.assign(window, { __lastExport: { command, args } });
              if ((window as { __cancelSave?: boolean }).__cancelSave)
                return null;
              return command === "export_project_data"
                ? { path: "/Exports/projects.json", records: issues.length }
                : { path: "/Exports/issues.csv", records: 2 };
            }
            case "preview_import":
            case "import_project_data": {
              // A small stand-in for the backend: the format check, and a
              // copy of each issue with the next number.
              let data: { format?: string; issues?: { title: string }[] };
              try {
                data = JSON.parse((args as { content: string }).content);
              } catch {
                throw { code: "unreadable_file", detail: "Not JSON." };
              }
              if (data.format !== "unhollowed-2/projects")
                throw {
                  code: "invalid_file",
                  problems: ["This is not an Unhollowed 2 project export."],
                  total: 1,
                };
              const incoming = data.issues ?? [];
              const renumbered = incoming.map((_, index): [string, string] => [
                `ISS-${index + 1}`,
                `ISS-${issues.length + index + 1}`,
              ]);
              if (command === "import_project_data")
                for (const { title } of incoming) {
                  const time = now();
                  issues.push({
                    id: `issue-${issues.length + 1}`,
                    number: issues.length + 1,
                    projectId: null,
                    title,
                    description: empty,
                    status: "todo",
                    priority: "none",
                    startDate: null,
                    dueDate: null,
                    completedAt: null,
                    closed: false,
                    createdAt: time,
                    updatedAt: time,
                    labelIds: [],
                    milestoneId: null,
                    recurrenceId: null,
                    recurring: false,
                    archivedAt: null,
                  });
                }
              return {
                projects: 0,
                labelsCreated: 0,
                labelsReused: ["Bug"],
                milestones: 0,
                missions: 0,
                objectives: 0,
                issues: incoming.length,
                relationships: 0,
                renumbered,
                skippedLabelLinks: 0,
                completionRepaired: 1,
              };
            }
            case "list_saved_views":
              return structuredClone(
                [...views].sort((a, b) => a.name.localeCompare(b.name)),
              );
            case "create_saved_view":
            case "update_saved_view": {
              const { name, config } = args as unknown as {
                name: string;
                config: ViewConfig;
              };
              const trimmed = name.trim();
              if (
                views.some(
                  (view) =>
                    view.id !== args.id &&
                    view.name.toLowerCase() === trimmed.toLowerCase(),
                )
              )
                throw { code: "duplicate_name" };
              const existing = views.find((view) => view.id === args.id);
              if (command === "update_saved_view" && !existing)
                throw { code: "not_found" };
              const view: SavedView = existing ?? {
                id: `view-${views.length + 1}`,
                name: trimmed,
                config,
                createdAt: now(),
                updatedAt: now(),
              };
              Object.assign(view, { name: trimmed, config, updatedAt: now() });
              if (!existing) views.push(view);
              return structuredClone(view);
            }
            case "delete_saved_view": {
              const index = views.findIndex((view) => view.id === args.id);
              if (index < 0) throw { code: "not_found" };
              views.splice(index, 1);
              return null;
            }
            case "list_calendars":
              calendarDefault();
              return structuredClone(calendars);
            case "create_calendar":
            case "update_calendar": {
              calendarDefault();
              const input = (args as unknown as { input: CalendarInput }).input;
              const name = input.name.trim();
              if (!name) throw { code: "invalid_name" };
              if (
                calendars.some(
                  (item) =>
                    item.id !== args.id &&
                    item.name.toLowerCase() === name.toLowerCase(),
                )
              )
                throw { code: "duplicate_name" };
              if (command === "update_calendar") {
                const calendar = findCalendar(args.id);
                Object.assign(calendar, { ...input, name, updatedAt: now() });
                return structuredClone(calendar);
              }
              const calendar: Calendar = {
                id: `calendar-${calendars.length + 1}`,
                ...input,
                name,
                isDefault: false,
                hidden: false,
                archivedAt: null,
                createdAt: now(),
                updatedAt: now(),
              };
              calendars.push(calendar);
              return structuredClone(calendar);
            }
            case "set_calendar_hidden": {
              const calendar = findCalendar(args.id);
              calendar.hidden = (args as unknown as { hidden: boolean }).hidden;
              return structuredClone(calendar);
            }
            case "set_default_calendar": {
              const calendar = findCalendar(args.id);
              if (calendar.archivedAt) throw { code: "calendar_archived" };
              for (const item of calendars) item.isDefault = item === calendar;
              return structuredClone(calendar);
            }
            case "archive_calendar": {
              const calendar = findCalendar(args.id);
              const replacement = (
                args as unknown as { replacement: string | null }
              ).replacement;
              if (calendar.isDefault) {
                const next = calendars.find(
                  (item) =>
                    item.id === replacement &&
                    item !== calendar &&
                    !item.archivedAt,
                );
                if (!next) throw { code: "replacement_required" };
                for (const item of calendars) item.isDefault = item === next;
              }
              calendar.archivedAt ??= now();
              return structuredClone(calendar);
            }
            case "restore_calendar": {
              const calendar = findCalendar(args.id);
              calendar.archivedAt = null;
              return structuredClone(calendar);
            }
            case "list_calendar_items": {
              seededEvents();
              const { from, to, timeZone } = (
                args as unknown as {
                  range: { from: string; to: string; timeZone: string };
                }
              ).range;
              // Seeded events with a UTC instant are shown in the viewer's
              // zone, like the backend; others at their entered times.
              const viewerLocal = (
                instant: string | null,
                local: string | null,
              ) => {
                if (!instant) return local;
                const parts = new Intl.DateTimeFormat("en-CA", {
                  timeZone,
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                }).formatToParts(new Date(instant));
                const part = (type: string) =>
                  parts.find((item) => item.type === type)!.value;
                return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
              };
              // The instant a wall-clock time is in a zone, as the backend
              // stores it.
              const toInstant = (local: string, zone: string) => {
                const wanted = Date.parse(`${local}:00Z`);
                let guess = wanted;
                for (let pass = 0; pass < 3; pass++) {
                  const parts = new Intl.DateTimeFormat("en-CA", {
                    timeZone: zone,
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    hourCycle: "h23",
                  }).formatToParts(new Date(guess));
                  const part = (type: string) =>
                    parts.find((item) => item.type === type)!.value;
                  const shownWall = Date.parse(
                    `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00Z`,
                  );
                  guess += wanted - shownWall;
                }
                return new Date(guess).toISOString().slice(0, 19) + "Z";
              };
              const shown = new Set(
                calendars
                  .filter(({ hidden, archivedAt }) => !hidden && !archivedAt)
                  .map(({ id }) => id),
              );
              calendarDefault();
              const items: CalendarItem[] = [];
              const base = (
                kind: CalendarItem["kind"],
                id: string,
                title: string,
              ): CalendarItem => ({
                kind,
                id,
                eventId: null,
                occurrence: null,
                recurring: false,
                title,
                calendarId: null,
                color: null,
                issueId: null,
                issueNumber: null,
                closed: false,
                allDay: true,
                startDate: null,
                endDate: null,
                start: null,
                end: null,
                startAt: null,
                endAt: null,
                timeZone: null,
                localStart: null,
                localEnd: null,
              });
              for (const event of events) {
                if (!shown.has(event.calendarId)) continue;
                const color =
                  calendars.find(({ id }) => id === event.calendarId)?.color ??
                  "blue";
                const spans = event.repeatFreq
                  ? occurrencesOf(event, from, to)
                  : [
                      {
                        key: null,
                        start: event.allDay
                          ? event.startDate!
                          : viewerLocal(event.startAt, event.startLocal)!,
                        end: event.allDay
                          ? event.endDate!
                          : viewerLocal(event.endAt, event.endLocal)!,
                        title: event.title,
                      },
                    ];
                for (const span of spans) {
                  if (!(span.start < to && span.end > from)) continue;
                  items.push({
                    ...base(
                      "event",
                      span.key ? `${event.id}:${span.key}` : event.id,
                      span.title,
                    ),
                    eventId: event.id,
                    occurrence: span.key,
                    recurring: Boolean(event.repeatFreq),
                    calendarId: event.calendarId,
                    color,
                    allDay: event.allDay,
                    startDate: event.allDay ? span.start : null,
                    endDate: event.allDay ? span.end : null,
                    start: event.allDay ? null : span.start,
                    end: event.allDay ? null : span.end,
                    startAt: event.allDay
                      ? null
                      : (!event.repeatFreq && event.startAt) ||
                        toInstant(span.start, timeZone),
                    endAt: event.allDay
                      ? null
                      : (!event.repeatFreq && event.endAt) ||
                        toInstant(span.end, timeZone),
                    timeZone: event.timeZone,
                    localStart: event.allDay ? null : span.start,
                    localEnd: event.allDay ? null : span.end,
                  });
                }
              }
              for (const issue of issues)
                if (
                  issue.dueDate &&
                  !issue.archivedAt &&
                  issue.dueDate >= from &&
                  issue.dueDate < to
                )
                  items.push({
                    ...base("deadline", issue.id, issue.title),
                    issueId: issue.id,
                    issueNumber: issue.number,
                    closed: issue.closed,
                    startDate: issue.dueDate,
                  });
              for (const block of workBlocks) {
                const issue = issues.find(({ id }) => id === block.issueId);
                const start = viewerLocal(block.startAt, block.startLocal)!;
                const end = viewerLocal(block.endAt, block.endLocal)!;
                if (!issue || issue.archivedAt || !(start < to && end > from))
                  continue;
                items.push({
                  ...base("workBlock", block.id, issue.title),
                  issueId: issue.id,
                  issueNumber: issue.number,
                  closed: issue.closed,
                  allDay: false,
                  startDate: null,
                  endDate: null,
                  start,
                  end,
                  startAt: block.startAt,
                  endAt: block.endAt,
                  timeZone: block.timeZone,
                  localStart: block.startLocal,
                  localEnd: block.endLocal,
                });
              }
              items.sort((a, b) =>
                (a.startDate ?? a.start!).localeCompare(
                  b.startDate ?? b.start!,
                ),
              );
              return { items: structuredClone(items), truncated: false };
            }
            case "get_calendar_event":
              return structuredClone(findEvent(args.id));
            case "create_calendar_event": {
              seededEvents();
              const input = (args as unknown as { input: EventInput }).input;
              const calendar = input.calendarId
                ? findCalendar(input.calendarId)
                : calendarDefault();
              if (calendar.archivedAt) throw { code: "calendar_not_found" };
              const event: CalendarEvent = {
                id: `event-${events.length + 1}`,
                calendarId: calendar.id,
                ...eventFields(input),
                createdAt: now(),
                updatedAt: now(),
              };
              events.push(event);
              return structuredClone(event);
            }
            case "update_calendar_event": {
              const event = findEvent(args.id);
              const input = (args as unknown as { input: EventInput }).input;
              const fields = eventFields(input);
              if (input.calendarId && input.calendarId !== event.calendarId) {
                const calendar = findCalendar(input.calendarId);
                if (calendar.archivedAt) throw { code: "calendar_not_found" };
                event.calendarId = calendar.id;
              }
              Object.assign(event, fields, { updatedAt: now() });
              return structuredClone(event);
            }
            case "duplicate_calendar_event": {
              const event = findEvent(args.id);
              const copy = {
                ...structuredClone(event),
                id: `event-${events.length + 1}`,
              };
              events.push(copy);
              return structuredClone(copy);
            }
            case "list_issue_work_blocks":
              return structuredClone(
                workBlocks
                  .filter(
                    (block) =>
                      block.issueId === (args as { issueId: string }).issueId,
                  )
                  .sort((a, b) => a.startAt.localeCompare(b.startAt)),
              );
            case "create_issue_work_block":
            case "update_issue_work_block": {
              const input = (
                command === "create_issue_work_block"
                  ? args.input
                  : (args as { input: object }).input
              ) as {
                issueId?: string;
                timeZone: string;
                start: string;
                end: string;
              };
              if (input.end <= input.start) throw { code: "invalid_range" };
              const block = {
                id:
                  command === "create_issue_work_block"
                    ? `block-${workBlocks.length + 1}`
                    : (args.id as string),
                issueId: input.issueId ?? "",
                timeZone: input.timeZone,
                startLocal: input.start,
                endLocal: input.end,
                startAt: `${input.start}:00Z`,
                endAt: `${input.end}:00Z`,
                createdAt: now(),
                updatedAt: now(),
              };
              if (command === "create_issue_work_block") workBlocks.push(block);
              else {
                const found = workBlocks.find(({ id }) => id === block.id);
                if (!found) throw { code: "not_found" };
                Object.assign(found, { ...block, issueId: found.issueId });
                return structuredClone(found);
              }
              return structuredClone(block);
            }
            case "delete_issue_work_block": {
              const index = workBlocks.findIndex(({ id }) => id === args.id);
              if (index < 0) throw { code: "not_found" };
              workBlocks.splice(index, 1);
              return null;
            }
            case "delete_calendar_event": {
              const event = findEvent(args.id);
              events.splice(events.indexOf(event), 1);
              return null;
            }
            case "pick_ics_file":
              return (
                (window as unknown as { __icsFile?: object }).__icsFile ?? null
              );
            case "preview_ics_import":
            case "import_ics": {
              const content = (args as unknown as { content: string }).content;
              if (!content.includes("BEGIN:VCALENDAR"))
                return {
                  fatal: "This is not an iCalendar file.",
                  found: 0,
                  imported: [],
                  duplicates: [],
                  skipped: [],
                  warnings: [],
                  applied: false,
                };
              return {
                fatal: null,
                found: 4,
                imported: [
                  {
                    title: "Standup",
                    uid: "a",
                    recurring: true,
                    exceptions: 2,
                  },
                  {
                    title: "Holiday",
                    uid: "b",
                    recurring: false,
                    exceptions: 0,
                  },
                ],
                duplicates: [
                  { title: "Old", uid: "c", recurring: false, exceptions: 0 },
                ],
                skipped: [
                  {
                    title: "Gym",
                    uid: "d",
                    message:
                      "The repeat rule uses BYDAY, which is not supported.",
                  },
                ],
                warnings: [
                  "ATTENDEE is not supported and was ignored in 1 event(s).",
                ],
                applied: command === "import_ics",
              };
            }
            case "export_calendar_ics":
              return (window as unknown as { __icsCancel?: boolean })
                .__icsCancel
                ? null
                : {
                    path: "/Users/test/unhollowed-calendar.ics",
                    events: events.length,
                  };
            case "get_reminders_enabled":
              return remindersOn;
            case "set_reminders_enabled":
              remindersOn = (args as unknown as { enabled: boolean }).enabled;
              return remindersOn;
            case "get_event_reminder":
              findEvent(args.id ?? (args as { eventId?: string }).eventId);
              return (
                eventReminders.get(
                  (args as unknown as { eventId: string }).eventId,
                ) ?? null
              );
            case "set_event_reminder": {
              const { eventId, minutesBefore } = args as unknown as {
                eventId: string;
                minutesBefore: number | null;
              };
              findEvent(eventId);
              if (minutesBefore === null) eventReminders.delete(eventId);
              else eventReminders.set(eventId, minutesBefore);
              return minutesBefore;
            }
            case "claim_due_reminders":
              return {
                delivered: [],
                failed: (window as unknown as { __reminderFailures?: number })
                  .__reminderFailures
                  ? 1
                  : 0,
              };
            case "send_test_notification":
              return null;
            case "get_event_links":
            case "link_event_document":
            case "unlink_event_document":
            case "link_event_project":
            case "unlink_event_project": {
              const { eventId, id } = args as unknown as {
                eventId: string;
                id: string;
              };
              findEvent(eventId);
              const table = command.endsWith("document")
                ? eventDocuments
                : eventProjects;
              const index = table.findIndex(
                ([event, target]) => event === eventId && target === id,
              );
              if (command.startsWith("link_") && index < 0)
                table.push([eventId, id]);
              if (command.startsWith("unlink_") && index >= 0)
                table.splice(index, 1);
              return {
                documents: eventDocuments
                  .filter(([event]) => event === eventId)
                  .map(([, target]) => ({
                    id: target,
                    title: documents.find((item) => item.id === target)!.title,
                    archived: false,
                  })),
                projects: eventProjects
                  .filter(([event]) => event === eventId)
                  .map(([, target]) => {
                    const project = projects.find(
                      (item) => item.id === target,
                    )!;
                    return {
                      id: target,
                      title: project.name,
                      archived: project.status === "archived",
                    };
                  }),
              };
            }
            case "update_event_occurrence":
            case "cancel_event_occurrence": {
              const event = findEvent(args.id);
              const key = (args as unknown as { occurrence: string })
                .occurrence;
              if (command === "cancel_event_occurrence")
                changes.set(`${event.id}|${key}`, { canceled: true });
              else {
                const input = (args as unknown as { input: EventInput }).input;
                changes.set(`${event.id}|${key}`, {
                  canceled: false,
                  title: input.title,
                  start: input.allDay ? input.startDate! : input.start!,
                  end: input.allDay ? input.endDate! : input.end!,
                });
              }
              return null;
            }
            case "split_event_series": {
              const event = findEvent(args.id);
              const key = (args as unknown as { occurrence: string })
                .occurrence;
              const input = (args as unknown as { input: EventInput }).input;
              event.repeatCount = null;
              event.repeatUntil = shiftDays(key.slice(0, 10), -1);
              const created: CalendarEvent = {
                ...structuredClone(event),
                id: `event-${events.length + 1}`,
                ...eventFields(input),
              };
              events.push(created);
              return {
                series: structuredClone(event),
                created: structuredClone(created),
                keptChanges: 0,
                droppedChanges: 0,
              };
            }
            case "end_event_series": {
              const event = findEvent(args.id);
              const key = (args as unknown as { occurrence: string })
                .occurrence;
              event.repeatCount = null;
              event.repeatUntil = shiftDays(key.slice(0, 10), -1);
              return structuredClone(event);
            }
            case "list_labels":
              return structuredClone(
                labels
                  .map((label) => ({
                    ...label,
                    issueCount: issues.filter((issue) =>
                      issue.labelIds.includes(label.id),
                    ).length,
                  }))
                  .sort(
                    (a, b) =>
                      Number(a.archived) - Number(b.archived) ||
                      a.name.localeCompare(b.name),
                  ),
              );
            case "create_label":
            case "update_label": {
              const input = (args as unknown as { input: LabelInput }).input;
              const name = input.name.trim();
              if (
                labels.some(
                  (label) =>
                    label.id !== args.id &&
                    label.name.toLowerCase() === name.toLowerCase(),
                )
              )
                throw { code: "duplicate_name" };
              const existing = labels.find((label) => label.id === args.id);
              if (command === "update_label" && !existing)
                throw { code: "not_found" };
              const label: Label = existing ?? {
                id: `label-${labels.length + 1}`,
                archived: false,
                archivedAt: null,
                issueCount: 0,
                createdAt: now(),
                updatedAt: now(),
                name,
                description: null,
                color: input.color,
              };
              Object.assign(label, { ...input, name, updatedAt: now() });
              if (!existing) labels.push(label);
              return structuredClone(label);
            }
            case "archive_label":
            case "restore_label": {
              const label = labels.find((item) => item.id === args.id);
              if (!label) throw { code: "not_found" };
              label.archived = command === "archive_label";
              label.archivedAt = label.archived ? now() : null;
              return structuredClone(label);
            }
            case "set_issue_labels": {
              const issue = find(args.id);
              const wanted = [...new Set(args.labelIds ?? [])].sort();
              for (const id of wanted) {
                const label = labels.find((item) => item.id === id);
                if (!label) throw { code: "invalid_label" };
                if (label.archived && !issue.labelIds.includes(id))
                  throw { code: "label_archived" };
              }
              if (wanted.join() !== issue.labelIds.join()) {
                issue.labelIds = wanted;
                issue.updatedAt = now();
              }
              return structuredClone(issue);
            }
            case "get_issue":
              return structuredClone(find(args.id));
            case "create_issue": {
              const time = now();
              const issue: Issue = {
                id: `issue-${issues.length + 1}`,
                number: issues.length + 1,
                projectId: args.projectId ?? null,
                title: args.input!.title,
                description: args.input!.description ?? empty,
                status: "todo",
                priority: args.input!.priority ?? "none",
                startDate: args.input!.startDate,
                dueDate: args.input!.dueDate,
                completedAt: null,
                closed: false,
                createdAt: time,
                updatedAt: time,
                labelIds: [],
                milestoneId: null,
                recurrenceId: null,
                recurring: false,
                archivedAt: null,
              };
              issues.push(issue);
              return structuredClone(issue);
            }
            case "update_issue": {
              const issue = find(args.id);
              const input = args.input!;
              if (
                input.startDate &&
                input.dueDate &&
                input.startDate > input.dueDate
              )
                throw { code: "invalid_date_range" };
              Object.assign(issue, {
                ...input,
                description: input.description ?? empty,
                priority: input.priority ?? "none",
                updatedAt: now(),
              });
              return structuredClone(issue);
            }
            case "change_issue_status":
              return structuredClone(
                setStatus(find(args.id), args.status!, args.today),
              );
            case "complete_issue":
              return structuredClone(
                setStatus(find(args.id), "done", args.today),
              );
            case "set_issue_recurrence": {
              const issue = find(args.id);
              const rule = args.rule ?? null;
              const current = issue.recurrenceId
                ? series.get(issue.recurrenceId)
                : undefined;
              if (rule === null) {
                if (current) current.stopped = true;
              } else if (
                !current ||
                current.stopped ||
                current.frequency !== rule.frequency ||
                current.interval !== rule.interval
              ) {
                if (!issue.dueDate) throw { code: "recurrence_needs_due_date" };
                if (current) current.stopped = true;
                const id = `series-${series.size + 1}`;
                series.set(id, {
                  ...rule,
                  anchor: issue.dueDate,
                  stopped: false,
                });
                issue.recurrenceId = id;
                occurrence.set(issue.id, 0);
              }
              for (const item of issues)
                item.recurring = Boolean(
                  item.recurrenceId && !series.get(item.recurrenceId)?.stopped,
                );
              return structuredClone(issue);
            }
            case "get_issue_recurrence": {
              const issue = find(args.id);
              const rule = issue.recurrenceId && series.get(issue.recurrenceId);
              if (!rule) return null;
              const latest = issues
                .filter((item) => item.recurrenceId === issue.recurrenceId)
                .sort(
                  (a, b) =>
                    (occurrence.get(b.id) ?? 0) - (occurrence.get(a.id) ?? 0),
                )[0];
              return {
                id: issue.recurrenceId,
                frequency: rule.frequency,
                interval: rule.interval,
                anchorDate: rule.anchor,
                stopped: rule.stopped,
                stoppedAt: null,
                latestIssueId: latest.id,
                latestNumber: latest.number,
                latestDueDate: latest.dueDate,
                latestClosed: latest.closed,
              };
            }
            case "reopen_issue": {
              const issue = find(args.id);
              return structuredClone(
                issue.closed ? setStatus(issue, "todo") : issue,
              );
            }
            case "set_issue_project": {
              const issue = find(args.id);
              if (
                args.projectId &&
                !projects.some((item) => item.id === args.projectId)
              )
                throw { code: "invalid_project" };
              const target = args.projectId ?? null;
              // A milestone for another project no longer applies.
              const milestone = milestones.find(
                (item) => item.id === issue.milestoneId,
              );
              if (milestone?.projectId && milestone.projectId !== target)
                issue.milestoneId = null;
              issue.projectId = target;
              issue.updatedAt = now();
              return structuredClone(issue);
            }
            case "list_milestones":
              return structuredClone(
                milestones.map((milestone) => {
                  const linked = issues.filter(
                    (issue) => issue.milestoneId === milestone.id,
                  );
                  return {
                    ...milestone,
                    openCount: linked.filter((issue) => !issue.closed).length,
                    completedCount: linked.filter(
                      (issue) => issue.status === "done",
                    ).length,
                    canceledCount: linked.filter(
                      (issue) => issue.status === "canceled",
                    ).length,
                    blockedCount: linked.filter(
                      (issue) => issue.status === "blocked",
                    ).length,
                  };
                }),
              );
            case "create_milestone":
            case "update_milestone": {
              const input = (args as unknown as { input: MilestoneInput })
                .input;
              const existing = milestones.find((item) => item.id === args.id);
              if (command === "update_milestone" && !existing)
                throw { code: "not_found" };
              const milestone: Milestone = existing ?? {
                id: `milestone-${milestones.length + 1}`,
                projectId: args.projectId ?? null,
                closed: false,
                closedAt: null,
                openCount: 0,
                completedCount: 0,
                canceledCount: 0,
                blockedCount: 0,
                createdAt: now(),
                updatedAt: now(),
                title: "",
                description: null,
                dueDate: null,
              };
              Object.assign(milestone, input, { updatedAt: now() });
              if (!existing) milestones.push(milestone);
              return structuredClone(milestone);
            }
            case "close_milestone":
            case "reopen_milestone": {
              const milestone = milestones.find((item) => item.id === args.id);
              if (!milestone) throw { code: "not_found" };
              milestone.closed = command === "close_milestone";
              milestone.closedAt = milestone.closed ? now() : null;
              return structuredClone(milestone);
            }
            case "set_issue_due_date": {
              const issue = find(args.id);
              const due = (args as { dueDate?: string | null }).dueDate ?? null;
              if (due && issue.startDate && issue.startDate > due)
                throw { code: "invalid_date_range" };
              if (issue.dueDate !== due) {
                issue.dueDate = due;
                issue.updatedAt = now();
              }
              return structuredClone(issue);
            }
            case "set_issue_milestone": {
              const issue = find(args.id);
              const id = args.milestoneId ?? null;
              if (id) {
                const milestone = milestones.find((item) => item.id === id);
                if (
                  !milestone ||
                  (milestone.projectId &&
                    milestone.projectId !== issue.projectId)
                )
                  throw { code: "invalid_milestone" };
                if (milestone.closed && issue.milestoneId !== id)
                  throw { code: "milestone_closed" };
              }
              if (issue.milestoneId !== id) {
                issue.milestoneId = id;
                issue.updatedAt = now();
              }
              return structuredClone(issue);
            }
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      },
      isTauri: true,
    });
  });
}

/** Sends a test control event to the mock, such as `fail-command`. */
export function dispatch(page: Page, type: string, detail?: string) {
  return page.evaluate(
    ([name, value]) =>
      window.dispatchEvent(
        value === undefined
          ? new Event(name)
          : new CustomEvent(name, { detail: value }),
      ),
    [type, detail] as const,
  );
}
