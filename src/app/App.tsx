import { lazy, Suspense } from "react";
import { ProjectGoalsPage } from "../features/goals/ProjectGoals";
import { Link, Route, Routes } from "react-router";
import { Workspace } from "../components/layout/Workspace";
import { Documents } from "../features/documents/Documents";
import { Calendars } from "../features/calendar/Calendars";
import { CalendarPage } from "../features/calendar/CalendarPage";
import { Habits } from "../features/habits/Habits";
import { Mood } from "../features/mood/Mood";
import { Home } from "../features/home/Home";
import { TodayPage, UpcomingPage } from "../features/today/TaskViews";
import { IssueDetail } from "../features/issues/IssueDetail";
import {
  IssueBoardPage,
  Issues,
  ProjectBoard,
  ProjectIssues,
} from "../features/issues/Issues";
import { Labels } from "../features/labels/Labels";
import { Milestones } from "../features/milestones/Milestones";
import { Projects } from "../features/projects/Projects";
import { ProjectDetail } from "../features/projects/ProjectDetail";
import { Settings } from "../features/settings/Settings";
import { features } from "./pages";

const Graph = lazy(() => import("../features/graph/Graph"));

export function App() {
  return (
    <Routes>
      <Route element={<Workspace />}>
        <Route index element={<Home />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/today/upcoming" element={<UpcomingPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/calendar/calendars" element={<Calendars />} />
        <Route
          path="/graph"
          element={
            <Suspense fallback={<p role="status">Loading graph…</p>}>
              <Graph />
            </Suspense>
          }
        />
        <Route path="/habits" element={<Habits />} />
        <Route path="/mood" element={<Mood />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/projects/:id/goals" element={<ProjectGoalsPage />} />
        <Route path="/projects/:id/issues" element={<ProjectIssues />} />
        <Route path="/projects/:id/board" element={<ProjectBoard />} />
        <Route path="/issues" element={<Issues />} />
        <Route path="/issues/board" element={<IssueBoardPage />} />
        <Route path="/issues/labels" element={<Labels />} />
        <Route path="/issues/milestones" element={<Milestones />} />
        <Route path="/issues/:id" element={<IssueDetail />} />
        {features
          .filter(
            ({ path }) =>
              ![
                "/today",
                "/documents",
                "/projects",
                "/issues",
                "/calendar",
                "/graph",
                "/habits",
                "/mood",
              ].includes(path),
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
