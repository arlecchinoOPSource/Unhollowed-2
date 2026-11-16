import { useEffect, useState } from "react";
import { listLabels, type Label } from "../../database/labels";
import { listMilestones, type Milestone } from "../../database/milestones";
import { listProjects, type Project } from "../../database/projects";

/**
 * Projects, labels, and milestones for names in links, badges, filters, and
 * chips. Issue views still work if any of these fail to load.
 */
export function useIssueReferences(enabled: boolean) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  // True once all three loaded, so callers can tell "missing" from "loading".
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const keep =
      <T>(set: (value: T) => void) =>
      (value: T) => {
        if (current) set(value);
      };
    const all = [
      listProjects().then(keep(setProjects)),
      listLabels().then(keep(setLabels)),
      listMilestones().then(keep(setMilestones)),
    ];
    Promise.all(all).then(
      () => keep(setLoaded)(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [enabled]);

  return { projects, labels, milestones, loaded };
}
