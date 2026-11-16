import { Link, Route, Routes } from "react-router";
import { Workspace } from "../components/layout/Workspace";
import { Documents } from "../features/documents/Documents";
import { Home } from "../features/home/Home";
import { IssueDetail } from "../features/issues/IssueDetail";
import { Issues, ProjectIssues } from "../features/issues/Issues";
import { Projects } from "../features/projects/Projects";
import { ProjectDetail } from "../features/projects/ProjectDetail";
import { Settings } from "../features/settings/Settings";
import { features } from "./pages";

export function App() {
  return (
    <Routes>
      <Route element={<Workspace />}>
        <Route index element={<Home />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/projects/:id/issues" element={<ProjectIssues />} />
        <Route path="/issues" element={<Issues />} />
        <Route path="/issues/:id" element={<IssueDetail />} />
        {features
          .filter(
            ({ path }) =>
              !["/documents", "/projects", "/issues"].includes(path),
          )
          .map(({ path, title, description }) => (
            <Route
              key={path}
              path={path}
              element={
                <>
                  <h1>{title}</h1>
                  <p>{description}</p>
                  <p>Planned for a future release.</p>
                </>
              }
            />
          ))}
        <Route path="/settings" element={<Settings />} />
        <Route
          path="*"
          element={
            <>
              <h1>Page unavailable</h1>
              <Link to="/">Back to Home</Link>
            </>
          }
        />
      </Route>
    </Routes>
  );
}
