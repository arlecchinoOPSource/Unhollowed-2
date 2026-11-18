import { addDays, parseLocalDate } from "../today/dates";
import type { Period } from "./controls";

/**
 * Alignment for comparison widgets. Series from different features are put on
 * the same weeks or months (Monday to Sunday, or calendar months, both clipped
 * to the period, as the habit and check-in engines cut them), each keeping its
 * own unit and scale. Nothing here computes a metric: it only sums counts and
 * minutes that a query already produced, and says where a series cannot be
 * placed.
 */
export type Grain = "week" | "month";

export interface Bucket {
  start: string;
  end: string;
}

const lastOfMonth = (day: string) => {
  const [year, month] = day.split("-").map(Number);
  const last = new Date(0);
  last.setFullYear(year, month, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(last.getFullYear()).padStart(4, "0")}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
};

/** The weeks or months of `period`, in order, clipped to it. */
export function bucketsOf(period: Period, grain: Grain): Bucket[] {
  const out: Bucket[] = [];
  let start = period.from;
  while (start <= period.to) {
    const natural =
      grain === "week"
        ? addDays(start, (7 - parseLocalDate(start).getDay()) % 7)
        : lastOfMonth(start);
    const end = natural < period.to ? natural : period.to;
    out.push({ start, end });
    start = addDays(end, 1);
  }
  return out;
}

export interface Item {
  start: string;
  end: string;
  value: number;
}

export interface Aligned {
  /** One value per bucket; null where the source has nothing for it. */
  values: (number | null)[];
  /** Why the series could not be aligned, or null when it could. */
  problem: string | null;
  /** Buckets with a value. */
  covered: number;
  /** Sum of the values: equals the source's own total for the period. */
  total: number;
}

/**
 * Places items on buckets. A one-day item is added to the bucket holding its
 * day. A longer item (a week the source already cut) must match a bucket
 * exactly; otherwise the series cannot be aligned and says so rather than
 * splitting a week. A bucket that starts after `today` has no data yet.
 */
export function align(
  buckets: readonly Bucket[],
  items: readonly Item[],
  today: string,
  what: string,
): Aligned {
  const values: (number | null)[] = buckets.map(() => null);
  for (const item of items) {
    if (item.start === item.end) {
      const at = buckets.findIndex(
        (b) => b.start <= item.start && item.start <= b.end,
      );
      if (at < 0) continue;
      values[at] = (values[at] ?? 0) + item.value;
      continue;
    }
    const at = buckets.findIndex(
      (b) => b.start === item.start && b.end === item.end,
    );
    if (at < 0)
      return {
        values: buckets.map(() => null),
        problem: `${what} is grouped by week for periods over 92 days, so it cannot be shown by month.`,
        covered: 0,
        total: 0,
      };
    values[at] = (values[at] ?? 0) + item.value;
  }
  buckets.forEach((b, i) => {
    if (b.start > today) values[i] = null;
  });
  const present = values.filter((v): v is number => v !== null);
  return {
    values,
    problem: null,
    covered: present.length,
    total: present.reduce((sum, v) => sum + v, 0),
  };
}

/** Values keyed by an engine's own buckets (habits, check-ins) onto ours. */
export function fromEngine(
  buckets: readonly Bucket[],
  engine: readonly (Bucket & { value: number | null })[],
): Aligned {
  const values = buckets.map(
    (b) =>
      engine.find((e) => e.start === b.start && e.end === b.end)?.value ?? null,
  );
  const present = values.filter((v): v is number => v !== null);
  return {
    values,
    problem: null,
    covered: present.length,
    total: present.reduce((sum, v) => sum + v, 0),
  };
}
