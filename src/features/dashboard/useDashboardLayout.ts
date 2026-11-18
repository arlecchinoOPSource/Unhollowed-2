import { useCallback, useEffect, useRef, useState } from "react";
import {
  dashboardError,
  deleteDashboard,
  listDashboards,
  saveDashboard,
  setDefaultDashboard,
  type DashboardRecord,
} from "../../database/dashboards";
import {
  defaultDashboard,
  layoutFromLegacy,
  readLayout,
  withNewIds,
  type DashboardLayout,
  type Recovery,
} from "./layout";
import { defaultTemplate, fromTemplate, type Template } from "./templates";

const FIRST_NAME = "Dashboard";

export interface DashboardSummary {
  id: string;
  name: string;
  /** The one opened first. */
  isDefault: boolean;
}

export interface DashboardState {
  ready: boolean;
  dashboards: DashboardSummary[];
  activeId: string | null;
  layout: DashboardLayout;
  recovery: Recovery;
  notes: string[];
  /** Why the last read or save failed; changes still apply on screen. */
  problem: string;
  /** Applies a change and saves it, unless the record is from a newer release. */
  update: (change: (layout: DashboardLayout) => DashboardLayout) => void;
  /**
   * Saves a layout and shows it only if the save succeeded. On failure the
   * last committed layout stays and the reason comes back.
   */
  commit: (layout: DashboardLayout) => Promise<string | null>;
  /** Opens another dashboard. Nothing is saved. */
  select: (id: string) => void;
  /** Each returns an error message, or null on success. */
  create: (name: string, template: Template) => Promise<string | null>;
  rename: (name: string) => Promise<string | null>;
  duplicate: (name: string) => Promise<string | null>;
  remove: () => Promise<string | null>;
  makeDefault: () => Promise<string | null>;
  /** Replaces the open dashboard's widgets with the starter layout. */
  resetLayout: () => Promise<string | null>;
}

interface Inner {
  ready: boolean;
  records: DashboardRecord[];
  id: string | null;
  layout: DashboardLayout;
  recovery: Recovery;
  notes: string[];
  problem: string;
}

/**
 * The workspace's dashboards, stored in its database, and the one that is
 * open. The first visit creates one from the Phase 4 choices kept in this
 * browser, or from the defaults. Saves run one after another, so the last
 * change wins and a slow earlier save cannot overwrite it. A layout from a
 * newer release is shown as the default and never saved over.
 */
export function useDashboardLayout(
  today: string,
  enabled: boolean,
): DashboardState {
  const [state, setState] = useState<Inner>(() => ({
    ready: false,
    records: [],
    id: null,
    layout: defaultDashboard(today),
    recovery: "ok",
    notes: [],
    problem: "",
  }));
  const latest = useRef(state);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const commitState = useCallback((next: Inner) => {
    latest.current = next;
    setState(next);
  }, []);

  /** The state for showing `record` as the open dashboard. */
  const opened = useCallback(
    (records: DashboardRecord[], record: DashboardRecord, problem = "") => {
      const reading = readLayout(record.layout, record.layoutVersion, today);
      return {
        ready: true,
        records,
        id: record.id,
        layout: reading.layout,
        recovery: reading.recovery,
        notes: reading.notes,
        problem,
      } satisfies Inner;
    },
    [today],
  );

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const fallback = (problem: string, layout = defaultDashboard(today)) =>
      commitState({
        ready: true,
        records: [],
        id: null,
        layout,
        recovery: "ok",
        notes: [],
        problem,
      });
    (async () => {
      try {
        const records = await listDashboards();
        if (!live) return;
        if (records.length) return commitState(opened(records, records[0]));
        const layout = layoutFromLegacy(today);
        try {
          const saved = await saveDashboard(null, FIRST_NAME, layout);
          if (live) commitState(opened([saved], saved));
        } catch (cause) {
          if (live) fallback(dashboardError(cause), layout);
        }
      } catch (cause) {
        if (live) fallback(dashboardError(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, today, commitState, opened]);

  /** Runs `task` after any save already under way. */
  const queued = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const done = chain.current.then(task, task);
    chain.current = done.catch(() => undefined);
    return done;
  }, []);

  const name = () =>
    latest.current.records.find((item) => item.id === latest.current.id)
      ?.name ?? FIRST_NAME;

  const replaceRecord = (saved: DashboardRecord) =>
    latest.current.records.map((item) => (item.id === saved.id ? saved : item));

  const update = useCallback(
    (change: (layout: DashboardLayout) => DashboardLayout) => {
      const current = latest.current;
      const layout = change(current.layout);
      commitState({ ...current, layout });
      if (current.recovery === "newer") return;
      void queued(async () => {
        try {
          const saved = await saveDashboard(latest.current.id, name(), layout);
          commitState({
            ...latest.current,
            id: saved.id,
            records: latest.current.records.some((r) => r.id === saved.id)
              ? replaceRecord(saved)
              : [...latest.current.records, saved],
            problem: "",
          });
        } catch (cause) {
          commitState({ ...latest.current, problem: dashboardError(cause) });
        }
      });
    },
    [commitState, queued],
  );

  const commit = useCallback(
    (layout: DashboardLayout): Promise<string | null> => {
      if (latest.current.recovery === "newer")
        return Promise.resolve(dashboardError({ code: "newer_layout" }));
      return queued(async () => {
        try {
          const saved = await saveDashboard(latest.current.id, name(), layout);
          commitState({
            ...latest.current,
            id: saved.id,
            records: latest.current.records.some((r) => r.id === saved.id)
              ? replaceRecord(saved)
              : [...latest.current.records, saved],
            layout,
            problem: "",
          });
          return null;
        } catch (cause) {
          return dashboardError(cause);
        }
      });
    },
    [commitState, queued],
  );

  const select = useCallback(
    (id: string) => {
      const record = latest.current.records.find((item) => item.id === id);
      if (record) commitState(opened(latest.current.records, record));
    },
    [commitState, opened],
  );

  const add = useCallback(
    (title: string, layout: DashboardLayout) =>
      queued(async () => {
        try {
          const saved = await saveDashboard(null, title, layout);
          commitState(opened([...latest.current.records, saved], saved));
          return null;
        } catch (cause) {
          return dashboardError(cause);
        }
      }),
    [commitState, opened, queued],
  );

  const newer = () => dashboardError({ code: "newer_layout" });

  const create = useCallback(
    (title: string, template: Template) =>
      add(title, fromTemplate(template, today)),
    [add, today],
  );

  const duplicate = useCallback(
    async (title: string) => {
      if (latest.current.recovery === "newer") return newer();
      const layout = latest.current.layout;
      return add(title, { ...layout, widgets: withNewIds(layout.widgets) });
    },
    [add],
  );

  const rename = useCallback(
    (title: string): Promise<string | null> => {
      if (latest.current.recovery === "newer") return Promise.resolve(newer());
      return queued(async () => {
        try {
          const saved = await saveDashboard(
            latest.current.id,
            title,
            latest.current.layout,
          );
          commitState({ ...latest.current, records: replaceRecord(saved) });
          return null;
        } catch (cause) {
          return dashboardError(cause);
        }
      });
    },
    [commitState, queued],
  );

  const remove = useCallback(
    () =>
      queued(async () => {
        const id = latest.current.id;
        if (!id) return dashboardError({ code: "not_found" });
        try {
          await deleteDashboard(id);
          let records = latest.current.records.filter((item) => item.id !== id);
          // Never leave the workspace without a dashboard to open.
          if (!records.length) {
            const saved = await saveDashboard(
              null,
              FIRST_NAME,
              fromTemplate(defaultTemplate, today),
            );
            records = [saved];
          }
          commitState(opened(records, records[0]));
          return null;
        } catch (cause) {
          return dashboardError(cause);
        }
      }),
    [commitState, opened, queued, today],
  );

  const makeDefault = useCallback(
    () =>
      queued(async () => {
        const id = latest.current.id;
        if (!id) return dashboardError({ code: "not_found" });
        try {
          await setDefaultDashboard(id);
          const { records } = latest.current;
          commitState({
            ...latest.current,
            records: [
              ...records.filter((item) => item.id === id),
              ...records.filter((item) => item.id !== id),
            ],
          });
          return null;
        } catch (cause) {
          return dashboardError(cause);
        }
      }),
    [commitState, queued],
  );

  const resetLayout = useCallback(() => {
    if (latest.current.recovery === "newer") return Promise.resolve(newer());
    const { preferences } = latest.current.layout;
    const fresh = fromTemplate(defaultTemplate, today);
    return commit({ ...fresh, preferences });
  }, [commit, today]);

  return {
    ready: state.ready,
    dashboards: state.records.map((item, index) => ({
      id: item.id,
      name: item.name,
      isDefault: index === 0,
    })),
    activeId: state.id,
    layout: state.layout,
    recovery: state.recovery,
    notes: state.notes,
    problem: state.problem,
    update,
    commit,
    select,
    create,
    rename,
    duplicate,
    remove,
    makeDefault,
    resetLayout,
  };
}
