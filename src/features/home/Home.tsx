import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { features } from "../../app/pages";

export function Home() {
  return (
    <>
      <section className="welcome">
        <h1>Welcome to Unhollowed.</h1>
        <p>A private workspace for your notes, plans, and everyday routines.</p>
      </section>
      <section aria-labelledby="explore">
        <h2 id="explore">Explore your workspace</h2>
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
      </section>
    </>
  );
}
