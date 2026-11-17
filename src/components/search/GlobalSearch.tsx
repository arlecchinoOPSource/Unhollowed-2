import { FileText, Flag, FolderKanban, ListTodo, Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { issueKey, issueStatuses } from "../../database/issues";
import { searchWorkspace, type SearchResults } from "../../database/search";
import { isTauri } from "../../database/status";
import "./search.css";

const DELAY_MS = 150;

interface Option {
  id: string;
  label: string;
  detail: string;
  to: string;
  /** A link to the full list, offered as the group's last option. */
  more?: boolean;
}

/**
 * The header's search: a dialog that searches projects, issues, documents, and
 * milestones in the active workspace. Arrow keys move through grouped
 * results, Enter opens one, and Escape closes. Results from an older query
 * are ignored, so fast typing never shows stale matches.
 */
export function GlobalSearch() {
  const desktop = isTauri();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [results, setResults] = useState<{
    text: string;
    data: SearchResults;
  } | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const latest = useRef(0);
  const timer = useRef<number>(undefined);

  // Mod+K opens search from anywhere.
  useEffect(() => {
    if (!desktop) return;
    function shortcut(event: globalThis.KeyboardEvent) {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [desktop]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    // The input mounts with the dialog content.
    if (open) input.current?.select();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function search(value: string) {
    setText(value);
    setActive(0);
    window.clearTimeout(timer.current);
    const request = ++latest.current;
    if (!value.trim()) {
      setResults(null);
      setError("");
      return;
    }
    timer.current = window.setTimeout(() => {
      searchWorkspace(value).then(
        (data) => {
          if (request !== latest.current) return;
          setError("");
          setResults({ text: value, data });
        },
        () => {
          if (request === latest.current)
            setError("Could not search local storage. Try again.");
        },
      );
    }, DELAY_MS);
  }

  if (!desktop) {
    return (
      <button
        type="button"
        disabled
        title="Search is available in the desktop app"
      >
        <Search size={16} /> Search
      </button>
    );
  }

  const data = results?.text === text ? results.data : null;
  const loading = Boolean(text.trim()) && !data && !error;
  const groups: {
    title: string;
    icon: typeof Search;
    total: number;
    more?: { label: string; to: string };
    options: Option[];
    /** Matches beyond the cap when the group has no "See all" option. */
    hidden: number;
  }[] = data
    ? [
        {
          title: "Projects",
          icon: FolderKanban,
          total: data.projectTotal,
          options: data.projects.map((project) => ({
            id: `project-${project.id}`,
            label: project.name,
            detail:
              project.status === "archived" ? "Archived project" : "Project",
            to: `/projects/${project.id}`,
          })),
        },
        {
          title: "Issues",
          icon: ListTodo,
          total: data.issueTotal,
          more: {
            label: `See all ${data.issueTotal} matching issues`,
            to: `/issues?state=all&q=${encodeURIComponent(text.trim())}`,
          },
          options: data.issues.map((issue) => ({
            id: `issue-${issue.id}`,
            label: `${issueKey(issue)}: ${issue.title}`,
            detail: issueStatuses[issue.status],
            to: `/issues/${issue.id}`,
          })),
        },
        {
          title: "Documents",
          icon: FileText,
          total: data.documentTotal,
          options: data.documents.map((document) => ({
            id: `document-${document.id}`,
            label: document.title,
            detail: document.preview || "Document",
            to: `/documents?doc=${encodeURIComponent(document.id)}`,
          })),
        },
        {
          title: "Milestones",
          icon: Flag,
          total: data.milestoneTotal,
          more: { label: "Open milestones", to: "/issues/milestones" },
          options: data.milestones.map((milestone) => ({
            id: `milestone-${milestone.id}`,
            label: milestone.title,
            detail: [
              milestone.projectName ?? "Whole workspace",
              milestone.closed ? "closed" : null,
            ]
              .filter(Boolean)
              .join(", "),
            to: `/issues?state=all&milestone=${milestone.id}`,
          })),
        },
      ]
        .filter((group) => group.options.length > 0)
        .map((group) => ({
          ...group,
          // "See all" is an option too, so arrow keys reach it and a
          // listbox holds nothing but options.
          options:
            group.more && group.total > group.options.length
              ? [
                  ...group.options,
                  {
                    id: `more-${group.title}`,
                    label: group.more.label,
                    detail: "",
                    to: group.more.to,
                    more: true,
                  },
                ]
              : group.options,
          hidden: group.more ? 0 : group.total - group.options.length,
        }))
    : [];
  const options = groups.flatMap((group) => group.options);
  const current = options[Math.min(active, options.length - 1)];

  function go(to: string) {
    setOpen(false);
    void navigate(to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // A search field would clear itself on Escape; close the dialog instead.
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!options.length) return;
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) {
      event.preventDefault();
      setActive((index) => (index + step + options.length) % options.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      go(current.to);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        title="Search (⌘K or Ctrl+K)"
        onClick={() => setOpen(true)}
      >
        <Search size={16} aria-hidden="true" /> Search
      </button>
      <dialog
        ref={dialog}
        className="global-search"
        aria-label="Search the workspace"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          // A click on the backdrop closes the dialog.
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        {/* Content exists only while open, so its controls never linger
            hidden in the page. */}
        {open && (
          <>
            <div className="global-search-field">
              <Search size={18} aria-hidden="true" />
              <input
                ref={input}
                type="search"
                role="combobox"
                aria-label="Search projects, issues, documents, and milestones"
                aria-expanded={options.length > 0}
                aria-controls="global-search-results"
                aria-activedescendant={current ? current.id : undefined}
                aria-autocomplete="list"
                placeholder="Search projects, issues, documents, and milestones"
                value={text}
                maxLength={200}
                onChange={(event) => search(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            <p role="status" className="global-search-status">
              {!text.trim()
                ? "Type to search. Use an issue number like ISS-12 to jump to it."
                : error
                  ? error
                  : loading
                    ? "Searching…"
                    : options.length === 0
                      ? `No workspace results match “${text.trim()}”.`
                      : `${options.length} results shown.`}
            </p>
            <div id="global-search-results" role="listbox" aria-label="Results">
              {groups.map(
                ({ title, icon: Icon, total, hidden, options: items }) => (
                  <div
                    role="group"
                    aria-labelledby={`global-search-${title}`}
                    key={title}
                  >
                    {/* Names the group through aria-labelledby. Hidden so
                        the listbox owns only options. */}
                    <div
                      className="global-search-group"
                      id={`global-search-${title}`}
                      aria-hidden="true"
                    >
                      <Icon size={14} /> {title}
                      <span className="issue-count">{total}</span>
                      {hidden > 0 && (
                        <span className="global-search-detail">
                          , {hidden} more not shown. Refine the search.
                        </span>
                      )}
                    </div>
                    {items.map((option) => (
                      <div
                        key={option.id}
                        id={option.id}
                        role="option"
                        aria-selected={option === current}
                        className={
                          option.more
                            ? "global-search-option global-search-more"
                            : "global-search-option"
                        }
                        onMouseMove={() => setActive(options.indexOf(option))}
                        onClick={() => go(option.to)}
                      >
                        <span>{option.label}</span>
                        {option.detail && (
                          <span className="global-search-detail">
                            {option.detail}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ),
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
