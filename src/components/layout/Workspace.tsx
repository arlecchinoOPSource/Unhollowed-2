import { Moon, PanelLeft, Search, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { pages } from "../../app/pages";
import { isTauri } from "../../database/status";
import { isIssueShortcut } from "../../features/issues/issueKeyboard";
import { SidebarViews } from "../../features/views/SidebarViews";
import { useTheme } from "../../stores/theme";

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
    )?.title ?? "Workspace";

  return (
    <div className="workspace">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside id="sidebar" hidden={!sidebarOpen}>
        <Link to="/" className="wordmark">
          Unhollowed<span>.</span>
        </Link>
        <nav aria-label="Workspace">
          {pages.map(({ path, title, icon: Icon }) => (
            <NavLink to={path} end={path === "/"} key={path}>
              <Icon size={17} aria-hidden="true" />
              {title}
            </NavLink>
          ))}
        </nav>
        <SidebarViews />
      </aside>
      <div className="workspace-body">
        <header>
          <button
            type="button"
            aria-label="Toggle sidebar"
            aria-controls="sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <PanelLeft size={19} />
          </button>
          <span className="page-title">{title}</span>
          <div className="toolbar">
            <button type="button" disabled title="Search is planned">
              <Search size={16} /> Search
            </button>
            <button
              type="button"
              aria-label={
                theme === "light"
                  ? "Switch to dark mode"
                  : "Switch to light mode"
              }
              onClick={toggleTheme}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
