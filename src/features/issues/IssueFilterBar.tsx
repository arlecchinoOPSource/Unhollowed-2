import { ArrowDownWideNarrow, ArrowUpNarrowWide, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { Link } from "react-router";
import {
  issuePriorities,
  issueStatuses,
  type IssueSortField,
} from "../../database/issues";
import type { Label } from "../../database/labels";
import { fitsIssue, type Milestone } from "../../database/milestones";
import type { Project } from "../../database/projects";
import { fullDate } from "../calendar/monthGrid";
import { LabelPicker } from "../labels/LabelParts";
import {
  defaultDirection,
  duePresets,
  sortFields,
  type ListFilters,
} from "./filters";

const SEARCH_DELAY_MS = 250;

/**
 * The shared issue filter controls and active-filter chips. All Issues,
 * project issue lists, and boards render this over the same URL filters, so
 * a filter means the same thing everywhere.
 */
export function IssueFilterBar({
  filters,
  onChange,
  onReset,
  projectId,
  projects,
  labels,
  milestones,
  showStatus = true,
  searchRef,
  onSearchKeyDown,
}: {
  filters: ListFilters;
  onChange: (changes: Partial<ListFilters>) => void;
  /** Clears the narrowing filters. Called after pending search text is dropped. */
  onReset: () => void;
  /** Set on a project's list or board, which hides the Project filter. */
  projectId?: string;
  projects: Project[];
  labels: Label[];
  milestones: Milestone[];
  /** Boards show statuses as columns, so they hide the Status filter. */
  showStatus?: boolean;
  searchRef?: Ref<HTMLInputElement>;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  // Typed search text waits briefly before it updates the URL and reloads.
  const [typedSearch, setTypedSearch] = useState<string | null>(null);
  const searchTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  function search(value: string) {
    setTypedSearch(value);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setTypedSearch(null);
      onChange({ text: value });
    }, SEARCH_DELAY_MS);
  }

  function dropTypedSearch() {
    window.clearTimeout(searchTimer.current);
    setTypedSearch(null);
  }

  function reset() {
    dropTypedSearch();
    onReset();
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const milestoneTitles = new Map(
    milestones.map(({ id, title }) => [id, title]),
  );
  // In a project's list or board, offer only milestones its issues can use.
  const milestoneOptions = projectId
    ? milestones.filter((milestone) => fitsIssue(milestone, projectId))
    : milestones;
  const active: { label: string; clear: Partial<ListFilters> }[] = [];
  if (filters.text.trim())
    active.push({
      label: `Search: “${filters.text.trim()}”`,
      clear: { text: "" },
    });
  if (filters.status)
    active.push({
      label: `Status: ${issueStatuses[filters.status]}`,
      clear: { status: "" },
    });
  if (filters.priority)
    active.push({
      label: `Priority: ${issuePriorities[filters.priority]}`,
      clear: { priority: "" },
    });
  if (filters.project && !projectId)
    active.push({
      label: `Project: ${
        filters.project === "inbox"
          ? "Inbox"
          : (projectNames.get(filters.project) ?? "Unavailable project")
      }`,
      clear: { project: "" },
    });
  if (filters.completedFrom)
    active.push({
      label:
        filters.completedFrom === filters.completedTo
          ? `Completed: ${fullDate(filters.completedFrom)}`
          : `Completed: ${fullDate(filters.completedFrom)} to ${fullDate(filters.completedTo)}`,
      clear: { completedFrom: "", completedTo: "" },
    });
  for (const id of filters.labels)
    active.push({
      label: `Label: ${labelsById.get(id)?.name ?? "Unavailable label"}`,
      clear: { labels: filters.labels.filter((other) => other !== id) },
    });
  if (filters.labels.length > 1 && filters.labelMatch === "all")
    active.push({ label: "Match all labels", clear: { labelMatch: "any" } });
  if (filters.milestone)
    active.push({
      label: `Milestone: ${
        filters.milestone === "none"
          ? "None"
          : (milestoneTitles.get(filters.milestone) ?? "Unavailable milestone")
      }`,
      clear: { milestone: "" },
    });
  if (filters.archived)
    active.push({
      label:
        filters.archived === "only" ? "Only archived" : "Including archived",
      clear: { archived: "" },
    });
  if (filters.due)
    active.push({
      label: `Due: ${duePresets[filters.due]}`,
      clear: { due: "" },
    });
  if (!showStatus && filters.status)
    active.splice(
      active.findIndex(({ clear }) => "status" in clear),
      1,
    );

  return (
    <>
      <div className="issue-toolbar" role="search" aria-label="Find issues">
        <label className="issue-search">
          Search issues
          <input
            type="search"
            ref={searchRef}
            onKeyDown={onSearchKeyDown}
            placeholder="Search titles and descriptions"
            maxLength={200}
            value={typedSearch ?? filters.text}
            onChange={(event) => search(event.target.value)}
          />
        </label>
        {showStatus && (
          <label>
            Status
            <select
              value={filters.status}
              onChange={(event) =>
                onChange({
                  status: event.target.value as ListFilters["status"],
                })
              }
            >
              <option value="">Any status</option>
              {Object.entries(issueStatuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Priority
          <select
            value={filters.priority}
            onChange={(event) =>
              onChange({
                priority: event.target.value as ListFilters["priority"],
              })
            }
          >
            <option value="">Any priority</option>
            {Object.entries(issuePriorities).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!projectId && (
          <label>
            Project
            <select
              value={filters.project}
              onChange={(event) => onChange({ project: event.target.value })}
            >
              <option value="">Any project</option>
              <option value="inbox">Inbox (no project)</option>
              {projects
                .filter(
                  (project) =>
                    project.status !== "archived" ||
                    project.id === filters.project,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Due date
          <select
            value={filters.due}
            onChange={(event) =>
              onChange({ due: event.target.value as ListFilters["due"] })
            }
          >
            <option value="">Any due date</option>
            {Object.entries(duePresets).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Milestone
          <select
            value={filters.milestone}
            onChange={(event) => onChange({ milestone: event.target.value })}
          >
            <option value="">Any milestone</option>
            <option value="none">No milestone</option>
            {milestoneOptions.map((milestone) => (
              <option key={milestone.id} value={milestone.id}>
                {milestone.closed
                  ? `${milestone.title} (closed)`
                  : milestone.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Archived
          <select
            value={filters.archived}
            onChange={(event) =>
              onChange({
                archived: event.target.value as ListFilters["archived"],
              })
            }
          >
            <option value="">Hide archived</option>
            <option value="include">Include archived</option>
            <option value="only">Only archived</option>
          </select>
        </label>
        <details className="issue-label-filter">
          <summary>
            Labels
            {filters.labels.length > 0 && ` (${filters.labels.length})`}
          </summary>
          <div>
            <LabelPicker
              legend="Show issues with these labels"
              labels={labels}
              selected={filters.labels}
              allowArchived
              onChange={(ids) => onChange({ labels: ids })}
            />
            <label className="issue-label-match">
              <input
                type="checkbox"
                checked={filters.labelMatch === "all"}
                onChange={(event) =>
                  onChange({ labelMatch: event.target.checked ? "all" : "any" })
                }
              />
              Match all selected labels
            </label>
            <Link to="/issues/labels">Manage labels</Link>
          </div>
        </details>
        <div className="issue-sort">
          <label>
            Sort by
            <select
              value={filters.sort}
              onChange={(event) => {
                const sort = event.target.value as IssueSortField;
                onChange({ sort, direction: defaultDirection(sort) });
              }}
            >
              {Object.entries(sortFields).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="issue-direction"
            aria-label={
              filters.direction === "asc"
                ? "Sorted ascending. Switch to descending"
                : "Sorted descending. Switch to ascending"
            }
            title={filters.direction === "asc" ? "Ascending" : "Descending"}
            onClick={() =>
              onChange({
                direction: filters.direction === "asc" ? "desc" : "asc",
              })
            }
          >
            {filters.direction === "asc" ? (
              <ArrowUpNarrowWide size={16} aria-hidden="true" />
            ) : (
              <ArrowDownWideNarrow size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {active.length > 0 && (
        <div className="issue-active-filters">
          <span id="active-filters-label">Active filters</span>
          <ul aria-labelledby="active-filters-label">
            {active.map(({ label, clear }) => (
              <li key={label}>
                <button
                  type="button"
                  aria-label={`Remove filter ${label}`}
                  onClick={() => {
                    if ("text" in clear) dropTypedSearch();
                    onChange(clear);
                  }}
                >
                  {label}
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="issue-reset" onClick={reset}>
            Reset filters
          </button>
        </div>
      )}
    </>
  );
}
