import { Bookmark, Kanban } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { isTauri } from "../../database/status";
import { useSavedViews } from "../../stores/savedViews";
import { viewParams } from "../issues/filters";
import "./views.css";

/** Saved views in the sidebar, each opening its list or board. */
export function SidebarViews() {
  const desktop = isTauri();
  const { views, load } = useSavedViews();
  const { search } = useLocation();
  const openId = new URLSearchParams(search).get("view");

  useEffect(() => {
    if (desktop && views === null) void load();
  }, [desktop, views, load]);

  if (!desktop || !views || views.length === 0) return null;
  return (
    <section className="sidebar-views" aria-labelledby="sidebar-views-heading">
      <h2 id="sidebar-views-heading">Saved views</h2>
      <ul>
        {views.map((view) => {
          const Icon = view.config.view === "board" ? Kanban : Bookmark;
          const path =
            view.config.view === "board" ? "/issues/board" : "/issues";
          return (
            <li key={view.id}>
              <Link
                to={`${path}?${viewParams(view.config.filters, view.id)}`}
                aria-current={openId === view.id ? "page" : undefined}
              >
                <Icon size={15} aria-hidden="true" />
                {view.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
