import { ArrowRightLeft } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  changeIssueStatus,
  isClosedStatus,
  issueError,
  issueKey,
  issueStatuses,
  queryIssues,
  type IssueStatus,
  type IssueSummary,
} from "../../database/issues";
import { isTauri } from "../../database/status";
import { LabelBadges } from "../labels/LabelParts";
import { readFilters, resetFilters, toQuery, writeFilters } from "./filters";
import { PriorityBadge, RepeatMark, StatusBadge } from "./IssueBadges";
import { SavedViewBar } from "../views/SavedViewBar";
import { IssueFilterBar } from "./IssueFilterBar";
import { useIssueReferences } from "./useIssueReferences";
import "./board.css";

/** Cards loaded per column at a time, which bounds rendering on large boards. */
export const COLUMN_PAGE = 50;
const COLUMNS = Object.keys(issueStatuses) as IssueStatus[];
const DRAG_TYPE = "application/x-unhollowed-issue";

interface Column {
  issues: IssueSummary[];
  /** Matching issues in this status across all pages. */
  total: number;
}

type Columns = Record<IssueStatus, Column>;

/** Removes the issue from every column and adds `issue` to the top of its status. */
function place(columns: Columns, issue: IssueSummary): Columns {
  const next = { ...columns };
  for (const status of COLUMNS) {
    const column = next[status];
    if (column.issues.some(({ id }) => id === issue.id)) {
      next[status] = {
        issues: column.issues.filter(({ id }) => id !== issue.id),
        total: column.total - 1,
      };
    }
  }
  const target = next[issue.status];
  next[issue.status] = {
    issues: [issue, ...target.issues],
    total: target.total + 1,
  };
  return next;
}

/**
 * Issues grouped into one column per status. Cards move by drag and drop or
 * with each card's Move menu, through the same `change_issue_status` command
 * the list and detail pages use. Each column is its own paged query with the
 * shared filters, so large boards render at most `COLUMN_PAGE` cards per
 * column until more are requested.
 */
export function IssueBoard({ projectId }: { projectId?: string }) {
  const desktop = isTauri();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const [today] = useState(() => new Date());
  // Columns are statuses, so the board ignores the Status filter and tabs.
  const base = { ...toQuery(filters, today, projectId), state: "all" as const };
  delete base.statuses;
  const queryKey = JSON.stringify(base);
  const {
    projects,
    labels,
    milestones,
    loaded: referencesLoaded,
  } = useIssueReferences(desktop);
  const [columns, setColumns] = useState<Columns | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [moreLoading, setMoreLoading] = useState<IssueStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<IssueStatus | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // The newest move per issue. Only its response may change what is shown,
  // so a late reply to an older move cannot undo a newer one.
  const latestMove = useRef(new Map<string, number>());
  // The last saved version of an issue with unconfirmed moves, for rollback.
  const saved = useRef(new Map<string, IssueSummary>());
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const latestKey = useRef(queryKey);
  useEffect(() => {
    latestKey.current = queryKey;
  });

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    const query = JSON.parse(queryKey);
    Promise.all(
      COLUMNS.map((status) =>
        queryIssues({
          ...query,
          statuses: [status],
          limit: COLUMN_PAGE,
          offset: 0,
        }),
      ),
    ).then(
      (pages) => {
        if (!current) return;
        setColumns(
          Object.fromEntries(
            COLUMNS.map((status, index) => [
              status,
              { issues: pages[index].issues, total: pages[index].total },
            ]),
          ) as Columns,
        );
        setLoadedKey(`${queryKey}#${request}`);
      },
      (cause) => {
        if (current) setLoadError(issueError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, queryKey, request]);

  // Keep focus on a card after it moves to another column or back.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    moveButtons.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  function move(issue: IssueSummary, status: IssueStatus) {
    setMenuFor(null);
    if (issue.status === status) return;
    const number = (latestMove.current.get(issue.id) ?? 0) + 1;
    latestMove.current.set(issue.id, number);
    if (!saved.current.has(issue.id)) saved.current.set(issue.id, issue);
    setError("");
    setMessage("");
    pendingFocus.current = issue.id;
    setColumns(
      (current) =>
        current &&
        place(current, {
          ...issue,
          status,
          closed: isClosedStatus(status),
        }),
    );
    changeIssueStatus(issue.id, status).then(
      (result) => {
        if (latestMove.current.get(issue.id) !== number) {
          // A newer move is pending. Remember this result in case it fails.
          saved.current.set(issue.id, result);
          return;
        }
        saved.current.delete(issue.id);
        setColumns((current) => current && place(current, result));
        setMessage(
          `Moved ${issueKey(result)} to ${issueStatuses[result.status]}.`,
        );
      },
      (cause) => {
        if (latestMove.current.get(issue.id) !== number) return;
        const restored = saved.current.get(issue.id) ?? issue;
        saved.current.delete(issue.id);
        pendingFocus.current = issue.id;
        setColumns((current) => current && place(current, restored));
        setError(
          `Could not move ${issueKey(issue)} to ${issueStatuses[status]}. ` +
            `It is back in ${issueStatuses[restored.status]}. ${issueError(cause)}`,
        );
      },
    );
  }

  async function showMore(status: IssueStatus) {
    if (!columns || moreLoading) return;
    setMoreLoading(status);
    const key = queryKey;
    try {
      const page = await queryIssues({
        ...base,
        statuses: [status],
        limit: COLUMN_PAGE,
        offset: columns[status].issues.length,
      });
      if (key !== latestKey.current) return;
      setColumns((current) => {
        if (!current) return current;
        const known = new Set(current[status].issues.map(({ id }) => id));
        return {
          ...current,
          [status]: {
            issues: [
              ...current[status].issues,
              ...page.issues.filter(({ id }) => !known.has(id)),
            ],
            total: page.total,
          },
        };
      });
    } catch (cause) {
      setError(issueError(cause));
    } finally {
      setMoreLoading(null);
    }
  }

  function startDrag(event: DragEvent, issue: IssueSummary) {
    event.dataTransfer.setData(DRAG_TYPE, issue.id);
    event.dataTransfer.setData("text/plain", issueKey(issue));
    event.dataTransfer.effectAllowed = "move";
    setDragging(issue.id);
  }

  function drop(event: DragEvent, status: IssueStatus) {
    event.preventDefault();
    setDropTarget(null);
    setDragging(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const issue = columns
      ? COLUMNS.flatMap((column) => columns[column].issues).find(
          (item) => item.id === id,
        )
      : undefined;
    if (issue) move(issue, status);
  }

  if (!desktop) {
    return <p>Open the desktop app to see your issue board.</p>;
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const from = `${location.pathname}${location.search}`;
  const loading = columns !== null && loadedKey !== `${queryKey}#${request}`;

  return (
    <div className="issue-board-view">
      {!projectId && (
        <SavedViewBar
          kind="board"
          projects={projects}
          labels={labels}
          milestones={milestones}
          referencesLoaded={referencesLoaded}
        />
      )}
      <IssueFilterBar
        filters={filters}
        onChange={(changes) =>
          setParams(
            writeFilters({ ...filters, ...changes }, params.get("view")),
            {
              replace: true,
            },
          )
        }
        onReset={() =>
          setParams(writeFilters(resetFilters(filters), params.get("view")), {
            replace: true,
          })
        }
        projectId={projectId}
        projects={projects}
        labels={labels}
        milestones={milestones}
        showStatus={false}
      />
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {!loadError && columns === null && <p>Loading board…</p>}
      {columns && (
        <div className="issue-board" aria-busy={loading}>
          {COLUMNS.map((status) => {
            const column = columns[status];
            const headingId = `board-column-${status}`;
            return (
              <section
                key={status}
                className={`board-column${dropTarget === status ? " board-drop" : ""}`}
                aria-labelledby={headingId}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropTarget !== status) setDropTarget(status);
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    setDropTarget(null);
                }}
                onDrop={(event) => drop(event, status)}
              >
                <h2 id={headingId} className="board-column-heading">
                  <StatusBadge status={status} />
                  <span className="issue-count">
                    {column.total}
                    <span className="visually-hidden"> issues</span>
                  </span>
                </h2>
                {column.issues.length === 0 ? (
                  <p className="board-empty">No issues</p>
                ) : (
                  <ul aria-labelledby={headingId}>
                    {column.issues.map((issue) => (
                      <li
                        key={issue.id}
                        className={`board-card${dragging === issue.id ? " board-dragging" : ""}`}
                        draggable
                        onDragStart={(event) => startDrag(event, issue)}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                      >
                        <span className="issue-key">{issueKey(issue)}</span>
                        <Link
                          className="issue-title"
                          to={`/issues/${issue.id}`}
                          state={{ from }}
                          draggable={false}
                        >
                          {issue.title}
                        </Link>
                        <span className="issue-meta">
                          {issue.priority !== "none" && (
                            <PriorityBadge priority={issue.priority} />
                          )}
                          {!projectId &&
                            issue.projectId &&
                            projectNames.has(issue.projectId) && (
                              <span>{projectNames.get(issue.projectId)}</span>
                            )}
                          {issue.dueDate && (
                            <span>
                              Due{" "}
                              <time dateTime={issue.dueDate}>
                                {issue.dueDate}
                              </time>
                            </span>
                          )}
                          {issue.recurring && <RepeatMark />}
                          <LabelBadges
                            ids={issue.labelIds}
                            labels={labelsById}
                          />
                        </span>
                        <MoveMenu
                          issue={issue}
                          open={menuFor === issue.id}
                          onOpen={() => setMenuFor(issue.id)}
                          onClose={() => {
                            setMenuFor(null);
                            pendingFocus.current = issue.id;
                          }}
                          onMove={(target) => move(issue, target)}
                          buttonRef={(element) => {
                            if (element)
                              moveButtons.current.set(issue.id, element);
                            else moveButtons.current.delete(issue.id);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {column.issues.length < column.total && (
                  <button
                    type="button"
                    className="board-more"
                    aria-disabled={moreLoading !== null}
                    onClick={() => void showMore(status)}
                  >
                    {moreLoading === status
                      ? "Loading…"
                      : `Show more in ${issueStatuses[status]} (${
                          column.total - column.issues.length
                        })`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The keyboard and screen reader way to move a card: a button that opens a
 * short list of target statuses. Arrow keys move through the list, Enter or
 * Space moves the card, and Escape closes the list without moving.
 */
function MoveMenu({
  issue,
  open,
  onOpen,
  onClose,
  onMove,
  buttonRef,
}: {
  issue: IssueSummary;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onMove: (status: IssueStatus) => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const menu = useRef<HTMLUListElement>(null);
  const targets = COLUMNS.filter((status) => status !== issue.status);
  const menuId = `move-${issue.id}`;

  useEffect(() => {
    if (open) menu.current?.querySelector("button")?.focus();
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLUListElement>) {
    const items = [...(menu.current?.querySelectorAll("button") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) {
      event.preventDefault();
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="board-move">
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Move ${issueKey(issue)}: ${issue.title}`}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <ArrowRightLeft size={14} aria-hidden="true" /> Move
      </button>
      {open && (
        <ul
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={`Move ${issueKey(issue)} to`}
          onKeyDown={navigate}
        >
          {targets.map((status) => (
            <li key={status} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => onMove(status)}
              >
                {issueStatuses[status]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
