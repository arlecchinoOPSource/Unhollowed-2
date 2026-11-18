import { Link } from "react-router";
import { features } from "../../app/pages";
import { BrandMark } from "../../components/brand/BrandMark";
import { isTauri } from "../../database/status";
import { parseLocalDate } from "../today/dates";
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

function greeting(hour: number) {
  if (hour < 5 || hour >= 18) return "Good evening.";
  return hour < 12 ? "Good morning." : "Good afternoon.";
}

/**
 * Home: what needs attention today. Each section reads on its own, shows at
 * most a handful of items with a link to the full list, and says so when it
 * is empty or cannot be read, so one failing source never blanks the page.
 * The day comes from the local clock and the page re-reads when it changes.
 */
export function Home() {
  const desktop = isTauri();
  const today = useLocalToday();
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(parseLocalDate(today));
  return (
    <>
      <section className="home-hero">
        <BrandMark size={84} animate className="is-floating" />
        <div>
          <p className="home-date">{date}</p>
          <h1>{greeting(new Date().getHours())}</h1>
        </div>
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
        <p>Open the desktop app to see your day.</p>
      )}
      <section aria-labelledby="explore">
        <details className="home-areas">
          <summary id="explore">All areas</summary>
          <div className="feature-grid">
            {features.map(({ path, title, icon: Icon }) => (
              <Link className="feature-card" key={path} to={path}>
                <span className="feature-icon">
                  <Icon size={18} aria-hidden="true" />
                </span>
                {title}
              </Link>
            ))}
          </div>
        </details>
      </section>
    </>
  );
}
