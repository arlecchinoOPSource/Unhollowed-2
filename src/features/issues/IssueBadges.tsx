import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Minus,
  SignalHigh,
  SignalLow,
  SignalMedium,
  TriangleAlert,
} from "lucide-react";
import {
  issuePriorities,
  issueStatuses,
  type IssuePriority,
  type IssueStatus,
} from "../../database/issues";

const statusIcons = {
  todo: Circle,
  in_progress: CircleDot,
  blocked: CircleAlert,
  done: CircleCheck,
  canceled: CircleX,
};

const priorityIcons = {
  none: Minus,
  low: SignalLow,
  medium: SignalMedium,
  high: SignalHigh,
  urgent: TriangleAlert,
};

// Each indicator pairs its icon with a text label, so meaning never depends
// on color or shape alone.
export function StatusBadge({ status }: { status: IssueStatus }) {
  const Icon = statusIcons[status];
  return (
    <span className={`issue-status issue-status-${status}`}>
      <Icon size={14} aria-hidden="true" />
      {issueStatuses[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  const Icon = priorityIcons[priority];
  return (
    <span className={`issue-priority issue-priority-${priority}`}>
      <Icon size={14} aria-hidden="true" />
      {issuePriorities[priority]}
    </span>
  );
}
