import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { features } from "../../app/pages";
import { isTauri } from "../../database/status";
import { TodaySchedule } from "../today/TodaySchedule";
import { useLocalToday } from "../today/useLocalToday";
import {
  ActiveProjects,
  Attention,
  HabitsToday,
  InProgress,
  Milestones,
  RecentDocuments,
} from "./HomeSections";
import { QuickActions } from "./QuickActions";
import "./home.css";
import "../today/today.css";

/**
 * Home: what needs attention today. Each section reads on its own, shows at
 * most a handful of items with a link to the full list, and says so when it
 * is empty or cannot be read, so one failing source never blanks the page.
 * The day comes from the local clock and the page re-reads when it changes.
 */
export function Home() {
  const desktop = isTauri();
  const today = useLocalToday();
  return (
    <>
      <section className="welcome">
        <h1>Welcome to Unhollowed.</h1>
        <p>A private workspace for your notes, plans, and everyday routines.</p>
      </section>
      {desktop ? (
        <>
          <QuickActions today={today} />
          <div className="home-grid" data-today={today}>
            <Attention today={today} />
            <InProgress today={today} />
            <TodaySchedule today={today} />
            <HabitsToday today={today} />
            <Milestones today={today} />
            <RecentDocuments today={today} />
            <ActiveProjects today={today} />
          </div>
        </>
      ) : (
        <p>Open the desktop app to see today's summary.</p>
      )}
      <section aria-labelledby="explore">
        <details className="home-areas">
          <summary id="explore">All areas</summary>
          <div className="feature-grid">
            {features.map(({ path, title, description, icon: Icon }) => (
              <Link className="feature-card" key={path} to={path}>
                <span className="feature-icon">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <ArrowUpRight
                  className="card-arrow"
                  size={16}
                  aria-hidden="true"
                />
                <h3>{title}</h3>
                <p>{description}</p>
              </Link>
            ))}
          </div>
        </details>
      </section>
    </>
  );
}
