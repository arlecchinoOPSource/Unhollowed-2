import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listHabits, type Habit } from "../../database/habits";
import { listProjects, type Project } from "../../database/projects";
import { isTauri } from "../../database/status";
import { dateRange, fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import {
  daysIn,
  defaults,
  periodProblem,
  presets,
  resolvePeriod,
  sections,
  type Period,
  type Preferences,
} from "./controls";
import { ordered, type DashboardLayout } from "./layout";
import { describe, move, resize, settle } from "./grid";
import { effectiveScope } from "./scope";
import { newWidget, WidgetLibrary, WidgetSettings } from "./WidgetLibrary";
import { DashboardManager } from "./DashboardManager";
import { useDashboardLayout } from "./useDashboardLayout";
import { WidgetHost } from "./WidgetHost";
import { widgetDefinition } from "./widgets";
import "./dashboard.css";

/**
 * The workspace dashboard. One period and one project or habit filter apply
 * to every section that they make sense for, so cards agree with each other
 * and with the screens they link to. The period and the visible sections are
 * remembered on this device; the filters are not, because they name records
 * that may be gone by the next visit.
 */
export function Dashboard() {
  const desktop = isTauri();
  const today = localDate(new Date());
  const dashboard = useDashboardLayout(today, desktop);
  // While arranging, a draft is shown; the committed layout is untouched
  // until Save succeeds, and Cancel simply drops the draft.
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [arrangeNote, setArrangeNote] = useState("");
  const [saveProblem, setSaveProblem] = useState("");
  const [library, setLibrary] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (library || settingsFor) return;
    const button = opener.current;
    opener.current = null;
    // The modal is gone. Restore focus before the next keyboard action.
    if (button?.isConnected) button.focus();
  }, [library, settingsFor]);
  const layout = draft ?? dashboard.layout;
  const prefs: Preferences = {
    preset: layout.preferences.preset,
    custom: layout.preferences.custom,
    hidden: layout.widgets.filter((item) => item.hidden).map((item) => item.id),
  };
  function setPrefs(next: Preferences) {
    dashboard.update((current): DashboardLayout => ({
      ...current,
      preferences: { preset: next.preset, custom: next.custom },
      widgets: current.widgets.map((item) => ({
        ...item,
        hidden: next.hidden.includes(item.id),
      })),
    }));
  }
  const [project, setProject] = useState("");
  const [habit, setHabit] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    listProjects().then(
      (list) =>
        live && setProjects(list.filter((item) => item.status !== "archived")),
      () => undefined,
    );
    listHabits().then(
      (list) => live && setHabits(list.filter((item) => !item.archivedOn)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [desktop]);

  const period: Period = useMemo(
    () => resolvePeriod(prefs, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout.preferences, today],
  );
  const problem =
    prefs.preset === "custom" ? periodProblem(prefs.custom) : null;
  const filtered = project !== "" || habit !== "";
  const changed = prefs.preset !== defaults(today).preset;
  const shown = (id: string) => !prefs.hidden.includes(id);
  const label = (id: string, type: string) =>
    sections.find(({ key }) => key === id)?.label ??
    widgetDefinition(type)?.label ??
    `Unknown widget (${type})`;
  const scope = project || null;

  return (
    <section className="dash-view">
      <h1>Dashboards</h1>
      {!desktop && <p>Open the desktop app to see your local progress.</p>}
      {desktop && !dashboard.ready && <p role="status">Loading dashboard…</p>}
      {desktop && dashboard.ready && (
        <>
          {dashboard.problem && <p role="alert">{dashboard.problem}</p>}
          {dashboard.recovery !== "ok" && (
            <p role="status">{dashboard.notes.join(" ")}</p>
          )}
          <div className="dash-toolbar">
            <DashboardManager
              dashboard={dashboard}
              disabled={draft !== null}
              onArrange={() => setDraft(dashboard.layout)}
            />
            <div className="dash-edit">
              {draft ? (
                <>
                  <button
                    type="button"
                    className="action"
                    onClick={async () => {
                      const problem = await dashboard.commit(draft);
                      setSaveProblem(problem ?? "");
                      if (!problem) {
                        setDraft(null);
                        setArrangeNote("");
                      }
                    }}
                  >
                    Save layout
                  </button>
                  <button
                    type="button"
                    className="action"
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setLibrary(true);
                    }}
                  >
                    Add widget
                  </button>
                  <button
                    type="button"
                    className="action"
                    onClick={() => {
                      setDraft(null);
                      setSaveProblem("");
                      setArrangeNote("");
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : null}
              {saveProblem && <p role="alert">{saveProblem}</p>}
              <p role="status" className="dash-arrange-note">
                {arrangeNote}
              </p>
            </div>
          </div>
          <div className="dash-controls">
            <div role="group" aria-label="Period">
              {presets.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className="action"
                  aria-pressed={prefs.preset === value}
                  onClick={() => setPrefs({ ...prefs, preset: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              Project
              <select
                value={project}
                onChange={(event) => {
                  setProject(event.target.value);
                  if (event.target.value) setHabit("");
                }}
              >
                <option value="">All projects</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Habit
              <select
                value={habit}
                disabled={project !== ""}
                onChange={(event) => setHabit(event.target.value)}
              >
                <option value="">All habits</option>
                {habits.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {(filtered || changed) && (
              <button
                type="button"
                className="action"
                onClick={() => {
                  setProject("");
                  setHabit("");
                  setPrefs({ ...prefs, preset: defaults(today).preset });
                }}
              >
                Clear filters
              </button>
            )}
          </div>
          {prefs.preset === "custom" && (
            <div
              className="dash-controls"
              role="group"
              aria-label="Custom dates"
            >
              {(["from", "to"] as const).map((edge) => (
                <label key={edge}>
                  {edge === "from" ? "From" : "To"}
                  <input
                    type="date"
                    value={prefs.custom[edge]}
                    min="1900-01-01"
                    onChange={(event) =>
                      setPrefs({
                        ...prefs,
                        custom: {
                          ...prefs.custom,
                          [edge]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {problem && (
            <p role="alert">
              {problem} Showing the last 30 days until the dates are valid.
            </p>
          )}
          <p role="status" className="dash-period">
            {dateRange(period.from, period.to)} ({daysIn(period)}{" "}
            {daysIn(period) === 1 ? "day" : "days"})
            {project ? " Filtered to one project." : ""}
            {habit ? " Habits filtered to one habit." : ""}
          </p>
          <details className="dash-details">
            <summary>Sections</summary>
            <div role="group" aria-label="Visible sections">
              {ordered(layout.widgets).map((item) => (
                <label key={item.id} className="dash-check">
                  <input
                    type="checkbox"
                    checked={shown(item.id)}
                    onChange={(event) =>
                      setPrefs({
                        ...prefs,
                        hidden: event.target.checked
                          ? prefs.hidden.filter((id) => id !== item.id)
                          : [...prefs.hidden, item.id],
                      })
                    }
                  />
                  <span>{label(item.id, item.type)}</span>
                </label>
              ))}
              {prefs.hidden.length > 0 && (
                <button
                  type="button"
                  className="action"
                  onClick={() => setPrefs({ ...prefs, hidden: [] })}
                >
                  Show all sections
                </button>
              )}
            </div>
          </details>
          {layout.widgets.length > 0 &&
            layout.widgets.every((item) => item.hidden) && (
              <p>All sections are hidden. Turn some on under Sections.</p>
            )}
          <div className="dash-grid" data-arranging={draft ? "" : undefined}>
            {ordered(settle(layout.widgets.filter((item) => !item.hidden))).map(
              (item) => {
                const act = (
                  change: (
                    list: typeof layout.widgets,
                  ) => typeof layout.widgets,
                  id = item.id,
                ) => {
                  if (!draft) return;
                  const widgets = change(draft.widgets);
                  setDraft({ ...draft, widgets });
                  const moved = widgets.find((box) => box.id === id)!;
                  setArrangeNote(
                    `${label(item.id, item.type)}: ${describe(moved)}.`,
                  );
                };
                const name = label(item.id, item.type);
                const scope_ = effectiveScope(
                  item.type,
                  item.config ?? undefined,
                  period,
                  today,
                  { project: project !== "", habit: habit !== "" },
                  presets.find(({ value }) => value === prefs.preset)?.label ??
                    "Dashboard period",
                );
                const usesPeriod =
                  widgetDefinition(item.type)?.filters.includes("period") ??
                  false;
                const resetPeriod = () => {
                  const strip = (list: typeof layout.widgets) =>
                    list.map((box) =>
                      box.id === item.id
                        ? {
                            ...box,
                            config:
                              Object.keys(box.config ?? {}).filter(
                                (key) => key !== "period",
                              ).length === 0
                                ? null
                                : Object.fromEntries(
                                    Object.entries(box.config ?? {}).filter(
                                      ([key]) => key !== "period",
                                    ),
                                  ),
                          }
                        : box,
                    );
                  if (draft)
                    setDraft({ ...draft, widgets: strip(draft.widgets) });
                  else
                    dashboard.update((current) => ({
                      ...current,
                      widgets: strip(current.widgets),
                    }));
                };
                return (
                  <div
                    key={item.id}
                    className="dash-cell"
                    data-cell={item.id}
                    style={
                      {
                        "--x": item.x + 1,
                        "--y": item.y + 1,
                        "--w": item.w,
                        "--h": item.h,
                      } as React.CSSProperties
                    }
                  >
                    {draft && (
                      <div
                        className="dash-arrange"
                        role="group"
                        aria-label={`Arrange ${name}`}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          const keys: Record<string, [number, number]> = {
                            ArrowLeft: [-1, 0],
                            ArrowRight: [1, 0],
                            ArrowUp: [0, -1],
                            ArrowDown: [0, 1],
                          };
                          const step = keys[event.key];
                          if (!step) return;
                          event.preventDefault();
                          act((list) =>
                            event.shiftKey
                              ? resize(list, item.id, step[0], step[1])
                              : move(list, item.id, step[0], step[1]),
                          );
                        }}
                      >
                        <span>
                          {name}. Arrow keys move; Shift with an arrow resizes.
                        </span>
                        {(
                          [
                            [
                              "Move left",
                              () => move(draft.widgets, item.id, -1, 0),
                            ],
                            [
                              "Move right",
                              () => move(draft.widgets, item.id, 1, 0),
                            ],
                            [
                              "Move up",
                              () => move(draft.widgets, item.id, 0, -1),
                            ],
                            [
                              "Move down",
                              () => move(draft.widgets, item.id, 0, 1),
                            ],
                            [
                              "Narrower",
                              () => resize(draft.widgets, item.id, -1, 0),
                            ],
                            [
                              "Wider",
                              () => resize(draft.widgets, item.id, 1, 0),
                            ],
                            [
                              "Shorter",
                              () => resize(draft.widgets, item.id, 0, -1),
                            ],
                            [
                              "Taller",
                              () => resize(draft.widgets, item.id, 0, 1),
                            ],
                          ] as const
                        ).map(([text, run]) => (
                          <button
                            key={text}
                            type="button"
                            className="action"
                            aria-label={`${text}: ${name}`}
                            onClick={() => act(run)}
                          >
                            {text}
                          </button>
                        ))}
                        {widgetDefinition(item.type)?.fields && (
                          <button
                            type="button"
                            className="action"
                            aria-label={`Settings: ${name}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setSettingsFor(item.id);
                            }}
                          >
                            Settings
                          </button>
                        )}
                        <button
                          type="button"
                          className="action"
                          aria-label={`Remove: ${name}`}
                          onClick={() => {
                            setDraft({
                              ...draft,
                              widgets: draft.widgets.filter(
                                (box) => box.id !== item.id,
                              ),
                            });
                            setArrangeNote(`${name} removed.`);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                    {/* Widgets that follow the dashboard say nothing extra: the
                        dashboard's own period line above already applies. */}
                    {((usesPeriod && scope_.own) ||
                      scope_.project === "unsupported" ||
                      scope_.habit === "unsupported") && (
                      <p className="dash-scope" data-scope={item.id}>
                        {usesPeriod && scope_.own && (
                          <>
                            <strong>Period:</strong> {scope_.periodLabel},{" "}
                            {fullDate(scope_.period.from)} to{" "}
                            {fullDate(scope_.period.to)}
                            {scope_.own
                              ? " (this widget's own period)"
                              : " (same as the dashboard)"}
                            {scope_.own && (
                              <button
                                type="button"
                                className="action"
                                aria-label={`Use the dashboard period: ${name}`}
                                onClick={resetPeriod}
                              >
                                Use dashboard period
                              </button>
                            )}
                          </>
                        )}
                        {scope_.project === "unsupported" &&
                          " The project filter does not apply here."}
                        {scope_.habit === "unsupported" &&
                          " The habit filter does not apply here."}
                      </p>
                    )}
                    <WidgetHost
                      instance={{ ...item, config: item.config ?? undefined }}
                      context={{
                        project: scope,
                        habit: habit || null,
                        period: scope_.period,
                      }}
                    />
                  </div>
                );
              },
            )}
          </div>
          {library && draft && (
            <WidgetLibrary
              context={{ project: scope, habit: habit || null, period }}
              onAdd={(definition) => {
                const added = newWidget(definition, draft.widgets);
                setDraft({ ...draft, widgets: [...draft.widgets, added] });
                setArrangeNote(`${definition.label} added.`);
              }}
              onClose={() => setLibrary(false)}
            />
          )}
          {settingsFor && draft && (
            <WidgetSettings
              period={period}
              widget={draft.widgets.find((box) => box.id === settingsFor)!}
              onApply={(config) => {
                setDraft({
                  ...draft,
                  widgets: draft.widgets.map((box) =>
                    box.id === settingsFor ? { ...box, config } : box,
                  ),
                });
                setArrangeNote("Settings applied.");
                setSettingsFor(null);
              }}
              onClose={() => setSettingsFor(null)}
            />
          )}
        </>
      )}
    </section>
  );
}
