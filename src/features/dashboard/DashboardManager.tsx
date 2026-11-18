import { useState } from "react";
import { Modal } from "./WidgetLibrary";
import { defaultTemplate, templates, type Template } from "./templates";
import type { DashboardState } from "./useDashboardLayout";

type Action = "new" | "rename" | "duplicate" | "delete" | "reset";

/**
 * Switch between named dashboards and manage them. Deleting or resetting
 * asks first, and says what is lost. Every action leaves a dashboard to open.
 */
export function DashboardManager({
  dashboard,
  disabled,
  onArrange,
}: {
  dashboard: DashboardState;
  disabled: boolean;
  /** Starts arranging the open dashboard's widgets. */
  onArrange: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<Template>(defaultTemplate);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const active = dashboard.dashboards.find(
    (item) => item.id === dashboard.activeId,
  );

  function open(next: Action) {
    setProblem("");
    setName(
      next === "rename"
        ? (active?.name ?? "")
        : next === "duplicate"
          ? `${active?.name ?? "Dashboard"} copy`.slice(0, 80)
          : "",
    );
    setAction(next);
  }

  async function run(task: () => Promise<string | null>, done: string) {
    setBusy(true);
    const failed = await task();
    setBusy(false);
    if (failed) return setProblem(failed);
    setNote(done);
    setAction(null);
  }

  const clean = name.trim();
  const nameProblem =
    clean.length === 0
      ? "Enter a name."
      : clean.length > 80
        ? "Use at most 80 characters."
        : "";

  return (
    <div className="dash-manager">
      <label>
        Dashboard
        <select
          value={dashboard.activeId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            dashboard.select(event.target.value);
            setNote("");
          }}
        >
          {dashboard.dashboards.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <details className="dash-details">
        <summary>Manage dashboards</summary>
        <div className="dash-manage-actions">
          <button
            type="button"
            className="action"
            disabled={disabled || !active}
            onClick={onArrange}
          >
            Arrange widgets
          </button>
          {(
            [
              ["new", "New dashboard"],
              ["rename", "Rename"],
              ["duplicate", "Duplicate"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="action"
              disabled={disabled || !active}
              onClick={() => open(key)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="action"
            disabled={disabled || !active || active.isDefault}
            onClick={() =>
              void run(
                dashboard.makeDefault,
                `${active?.name} is now the default.`,
              )
            }
          >
            Make default
          </button>
          <button
            type="button"
            className="action"
            disabled={disabled || !active}
            onClick={() => open("reset")}
          >
            Reset layout
          </button>
          <button
            type="button"
            className="action"
            disabled={disabled || !active}
            onClick={() => open("delete")}
          >
            Delete
          </button>
        </div>
      </details>
      <p role="status">{note}</p>
      {action &&
        (action === "new" || action === "rename" || action === "duplicate") && (
          <Modal
            title={
              action === "new"
                ? "New dashboard"
                : action === "rename"
                  ? "Rename dashboard"
                  : "Duplicate dashboard"
            }
            onClose={() => setAction(null)}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (nameProblem) return;
                void run(
                  () =>
                    action === "new"
                      ? dashboard.create(clean, template)
                      : action === "rename"
                        ? dashboard.rename(clean)
                        : dashboard.duplicate(clean),
                  action === "rename" ? "Renamed." : `Created ${clean}.`,
                );
              }}
            >
              <label className="dash-field">
                Name
                <input
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {action === "new" && (
                <fieldset className="dash-field">
                  <legend>Start from</legend>
                  {templates.map((item) => (
                    <label key={item.id} className="dash-check">
                      <input
                        type="radio"
                        name="template"
                        checked={template.id === item.id}
                        onChange={() => setTemplate(item)}
                      />
                      <span>
                        {item.name}: {item.description}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {(problem || (name !== "" && nameProblem)) && (
                <p role="alert">{problem || nameProblem}</p>
              )}
              <div className="dash-library-actions">
                <button
                  type="submit"
                  className="action"
                  disabled={busy || nameProblem !== ""}
                >
                  {action === "rename" ? "Rename" : "Create"}
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => setAction(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </Modal>
        )}
      {action === "delete" && (
        <Modal title="Delete dashboard?" onClose={() => setAction(null)}>
          <p>
            This deletes the dashboard “{active?.name}” and its layout. Your
            issues, habits, and other records are not touched. This cannot be
            undone.
            {dashboard.dashboards.length === 1 &&
              " It is your only dashboard, so a new General Productivity dashboard will be created."}
            {active?.isDefault &&
              dashboard.dashboards.length > 1 &&
              " It is the default, so the next dashboard becomes the default."}
          </p>
          {problem && <p role="alert">{problem}</p>}
          <div className="dash-library-actions">
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() => void run(dashboard.remove, "Dashboard deleted.")}
            >
              Delete dashboard
            </button>
            <button
              type="button"
              className="action"
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {action === "reset" && (
        <Modal title="Reset layout?" onClose={() => setAction(null)}>
          <p>
            This replaces the widgets on “{active?.name}” with the General
            Productivity starter layout. Your own arrangement and any widget
            settings, such as notes, are lost. The period you chose is kept.
          </p>
          {problem && <p role="alert">{problem}</p>}
          <div className="dash-library-actions">
            <button
              type="button"
              className="action"
              disabled={busy}
              onClick={() => void run(dashboard.resetLayout, "Layout reset.")}
            >
              Reset layout
            </button>
            <button
              type="button"
              className="action"
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
