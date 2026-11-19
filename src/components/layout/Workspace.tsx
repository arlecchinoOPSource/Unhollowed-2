import { Moon, PanelLeft, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { pages } from "../../app/pages";
import { BrandMark } from "../brand/BrandMark";
import { GlobalSearch } from "../search/GlobalSearch";
import { isTauri } from "../../database/status";
import { isIssueShortcut } from "../../features/issues/issueKeyboard";
import { ReminderRunner } from "../../features/calendar/ReminderRunner";
import { SidebarViews } from "../../features/views/SidebarViews";
import { UpdateButton } from "../../features/updates/UpdateButton";
import { useTheme } from "../../stores/theme";

// Navigation groups: the day, the work, the self, then settings.
const GROUP_STARTS = new Set(["/documents", "/habits", "/settings"]);

export function Workspace() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    function capture(event: KeyboardEvent) {
      if (!isIssueShortcut(event, "KeyN")) return;
      event.preventDefault();
      const input = document.getElementById("new-issue-title");
      if (input) input.focus();
      else void navigate("/issues", { state: { focusNewIssue: true } });
    }
    window.addEventListener("keydown", capture);
    return () => window.removeEventListener("keydown", capture);
  }, [navigate]);
  const { theme, toggleTheme } = useTheme();
  const title =
    pages.find(
      ({ path }) =>
        path === pathname || (path !== "/" && pathname.startsWith(`${path}/`)),
    )?.title ?? (pathname === "/updates" ? "Updates" : "Workspace");

  return (
    <div className="workspace">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside id="sidebar" className="sidebar" hidden={!sidebarOpen}>
        <Link to="/" className="wordmark" aria-label="Unhollowed home">
          <BrandMark size={30} animate />
          <span className="wordmark-text">Unhollowed</span>
        </Link>
        <nav aria-label="Workspace" className="sidebar-nav">
          {pages.map(({ path, title, icon: Icon }) => (
            <NavLink
              to={path}
              end={path === "/"}
              key={path}
              className={GROUP_STARTS.has(path) ? "nav-break" : undefined}
              title={title}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="nav-label">{title}</span>
            </NavLink>
          ))}
        </nav>
        <SidebarViews />
        <UpdateButton />
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <button
            type="button"
            aria-label="Toggle sidebar"
            aria-controls="sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <PanelLeft size={19} />
          </button>
          <span className="page-title" key={title}>
            {title}
          </span>
          <div className="toolbar">
            <GlobalSearch />
            <button
              type="button"
              aria-label={
                theme === "light"
                  ? "Switch to dark mode"
                  : "Switch to light mode"
              }
              onClick={toggleTheme}
            >
              {theme === "light" ? (
                <Moon size={18} className="theme-icon" key="moon" />
              ) : (
                <Sun size={18} className="theme-icon" key="sun" />
              )}
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <ReminderRunner />
          <RouteErrorBoundary resetKey={pathname}>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
  );
}
