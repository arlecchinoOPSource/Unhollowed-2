import { useCallback, useEffect, useRef, useState } from "react";
import {
  dashboardError,
  listDashboards,
  saveDashboard,
} from "../../database/dashboards";
import {
  defaultDashboard,
  layoutFromLegacy,
  readLayout,
  type DashboardLayout,
  type Recovery,
} from "./layout";

const NAME = "Dashboard";

export interface DashboardState {
  ready: boolean;
  layout: DashboardLayout;
  recovery: Recovery;
  notes: string[];
  /** Why the last read or save failed; changes still apply on screen. */
  problem: string;
  /** Applies a change and saves it, unless the record is from a newer release. */
  update: (change: (layout: DashboardLayout) => DashboardLayout) => void;
}

/**
 * The open dashboard, stored in the workspace database. The first visit
 * creates it from the Phase 4 choices kept in this browser, or from the
 * defaults. Saves run one after another, so the last change always wins and
 * a slow earlier save cannot overwrite it. A layout from a newer release is
 * shown as the default and never saved over.
 */
export function useDashboardLayout(
  today: string,
  enabled: boolean,
): DashboardState {
  const [state, setState] = useState(() => ({
    ready: false,
    id: null as string | null,
    layout: defaultDashboard(today),
    recovery: "ok" as Recovery,
    notes: [] as string[],
    problem: "",
  }));
  const latest = useRef(state);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: typeof state) => {
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const [first] = await listDashboards();
        if (!live) return;
        if (first) {
          const reading = readLayout(first.layout, first.layoutVersion, today);
          commit({
            ready: true,
            id: first.id,
            layout: reading.layout,
            recovery: reading.recovery,
            notes: reading.notes,
            problem: "",
          });
          return;
        }
        const layout = layoutFromLegacy(today);
        try {
          const saved = await saveDashboard(null, NAME, layout);
          if (live)
            commit({
              ready: true,
              id: saved.id,
              layout,
              recovery: "ok",
              notes: [],
              problem: "",
            });
        } catch (cause) {
          if (live)
            commit({
              ready: true,
              id: null,
              layout,
              recovery: "ok",
              notes: [],
              problem: dashboardError(cause),
            });
        }
      } catch (cause) {
        if (live)
          commit({
            ready: true,
            id: null,
            layout: defaultDashboard(today),
            recovery: "ok",
            notes: [],
            problem: dashboardError(cause),
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, today, commit]);

  const update = useCallback(
    (change: (layout: DashboardLayout) => DashboardLayout) => {
      const current = latest.current;
      const layout = change(current.layout);
      commit({ ...current, layout });
      // Nothing to save to: a newer record is left alone, and without a
      // stored dashboard (a failed first save) there is no row to update.
      if (current.recovery === "newer") return;
      chain.current = chain.current.then(async () => {
        try {
          const id = latest.current.id;
          const saved = await saveDashboard(id, NAME, layout);
          // A first save that failed earlier creates the record now.
          if (!id) commit({ ...latest.current, id: saved.id, problem: "" });
          else if (latest.current.problem)
            commit({ ...latest.current, problem: "" });
        } catch (cause) {
          commit({ ...latest.current, problem: dashboardError(cause) });
        }
      });
    },
    [commit],
  );

  return {
    ready: state.ready,
    layout: state.layout,
    recovery: state.recovery,
    notes: state.notes,
    problem: state.problem,
    update,
  };
}
