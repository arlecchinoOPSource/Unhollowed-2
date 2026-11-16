import { Bookmark } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Label } from "../../database/labels";
import type { Milestone } from "../../database/milestones";
import type { Project } from "../../database/projects";
import {
  createSavedView,
  deleteSavedView,
  updateSavedView,
  VIEW_CONFIG_VERSION,
  viewError,
  type ViewConfig,
} from "../../database/savedViews";
import { useSavedViews } from "../../stores/savedViews";
import {
  readFilters,
  sameFilters,
  toViewFilters,
  viewParams,
  writeFilters,
  type ListFilters,
} from "../issues/filters";
import "./views.css";

type Mode = "idle" | "save" | "rename" | "delete";

/**
 * Saves the current list or board filters as a named view, and updates,
 * renames, or deletes the open view. A view is open when the URL has
 * `?view=<id>`; changing filters keeps that ID, so changes can be saved back.
 */
export function SavedViewBar({
  kind,
  projects,
  labels,
  milestones,
  referencesLoaded,
}: {
  kind: "list" | "board";
  projects: Project[];
  labels: Label[];
  milestones: Milestone[];
  /** False until names load, so nothing is reported missing too early. */
  referencesLoaded: boolean;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const viewId = params.get("view");
  const { views, load, put, drop } = useSavedViews();
  const [mode, setMode] = useState<Mode>("idle");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (views === null) void load();
  }, [views, load]);

  useEffect(() => {
    if (mode === "save" || mode === "rename") nameInput.current?.focus();
  }, [mode]);

  const view = viewId ? views?.find(({ id }) => id === viewId) : undefined;
  const config = (current: ListFilters): ViewConfig => ({
    version: VIEW_CONFIG_VERSION,
    view: kind,
    filters: toViewFilters(current),
  });
  const savedFilters = view
    ? readFilters(viewParams(view.config.filters, view.id))
    : null;
  const changed = savedFilters !== null && !sameFilters(filters, savedFilters);

  // References that no longer exist. Archived labels and projects still
  // exist, so only deleted or foreign records are reported.
  const missing: string[] = [];
  if (referencesLoaded) {
    const project = filters.project;
    if (
      project &&
      project !== "inbox" &&
      !projects.some(({ id }) => id === project)
    )
      missing.push("a project");
    if (filters.labels.some((id) => !labels.some((label) => label.id === id)))
      missing.push("a label");
    const milestone = filters.milestone;
    if (
      milestone &&
      milestone !== "none" &&
      !milestones.some(({ id }) => id === milestone)
    )
      missing.push("a milestone");
  }

  function dropMissing() {
    setParams(
      writeFilters(
        {
          ...filters,
          project:
            filters.project === "inbox" ||
            projects.some(({ id }) => id === filters.project)
              ? filters.project
              : "",
          labels: filters.labels.filter((id) =>
            labels.some((label) => label.id === id),
          ),
          milestone:
            filters.milestone === "none" ||
            milestones.some(({ id }) => id === filters.milestone)
              ? filters.milestone
              : "",
        },
        viewId,
      ),
      { replace: true },
    );
    setMessage(
      view
        ? "Removed the unavailable filters. Update the view to keep this."
        : "Removed the unavailable filters.",
    );
  }

  async function act(work: () => Promise<string>) {
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      setMessage(await work());
      setMode("idle");
      requestAnimationFrame(() => actionButton.current?.focus());
    } catch (cause) {
      setError(viewError(cause));
    } finally {
      setSaving(false);
    }
  }

  function submitName(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a view name.");
      return;
    }
    void act(async () => {
      if (mode === "rename" && view) {
        const saved = await updateSavedView(view.id, trimmed, view.config);
        put(saved);
        return `Renamed the view to ${saved.name}.`;
      }
      const saved = await createSavedView(trimmed, config(filters));
      put(saved);
      setParams(writeFilters(filters, saved.id), { replace: true });
      return `Saved view ${saved.name}.`;
    });
  }

  return (
    <div className="saved-view-bar">
      {viewId && views !== null && !view && (
        <p role="alert">This saved view is no longer available.</p>
      )}
      {view && (
        <p className="saved-view-name">
          <Bookmark size={16} aria-hidden="true" />
          <span>
            View: <strong>{view.name}</strong>
            {changed && <span className="saved-view-changed"> (changed)</span>}
          </span>
        </p>
      )}
      {missing.length > 0 && (
        <div className="saved-view-missing" role="alert">
          <p>
            {view ? "This view refers to" : "These filters refer to"}{" "}
            {missing.join(" and ")} that {missing.length === 1 ? "is" : "are"}{" "}
            no longer available, so{" "}
            {missing.length === 1 ? "it does" : "they do"} not narrow the
            results.
          </p>
          <button type="button" onClick={dropMissing}>
            Remove unavailable filters
          </button>
        </div>
      )}
      {mode === "save" || mode === "rename" ? (
        <form className="saved-view-form" onSubmit={submitName}>
          <label htmlFor="saved-view-name">
            {mode === "rename" ? "New view name" : "View name"}
          </label>
          <input
            id="saved-view-name"
            ref={nameInput}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setMode("idle");
                requestAnimationFrame(() => actionButton.current?.focus());
              }
            }}
          />
          <button type="submit" className="action" aria-disabled={saving}>
            {mode === "rename" ? "Rename" : "Save"}
          </button>
          <button
            type="button"
            className="saved-view-secondary"
            onClick={() => setMode("idle")}
          >
            Cancel
          </button>
        </form>
      ) : mode === "delete" && view ? (
        <div className="saved-view-form" role="group" aria-label="Delete view">
          <p>
            Delete {view.name}? This removes only the saved view, not any
            issues.
          </p>
          <button
            type="button"
            className="action"
            onClick={() =>
              void act(async () => {
                await deleteSavedView(view.id);
                drop(view.id);
                setParams(writeFilters(filters), { replace: true });
                return `Deleted view ${view.name}.`;
              })
            }
          >
            Delete view
          </button>
          <button
            type="button"
            className="saved-view-secondary"
            onClick={() => setMode("idle")}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="saved-view-actions">
          {view ? (
            <>
              <button
                type="button"
                ref={actionButton}
                aria-disabled={!changed || saving}
                onClick={() =>
                  changed &&
                  void act(async () => {
                    const saved = await updateSavedView(
                      view.id,
                      view.name,
                      config(filters),
                    );
                    put(saved);
                    return `Updated view ${saved.name}.`;
                  })
                }
              >
                Update view
              </button>
              {changed && savedFilters && (
                <button
                  type="button"
                  onClick={() =>
                    void navigate(
                      `${kind === "board" ? "/issues/board" : "/issues"}?${viewParams(
                        view.config.filters,
                        view.id,
                      )}`,
                      { replace: true },
                    )
                  }
                >
                  Revert changes
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setName(view.name);
                  setMode("rename");
                }}
              >
                Rename
              </button>
              <button type="button" onClick={() => setMode("delete")}>
                Delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setName("");
                  setMode("save");
                }}
              >
                Save as new view
              </button>
            </>
          ) : (
            <button
              type="button"
              ref={actionButton}
              onClick={() => {
                setName("");
                setMode("save");
              }}
            >
              <Bookmark size={15} aria-hidden="true" /> Save view
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="saved-view-message">
        {message}
      </p>
    </div>
  );
}
