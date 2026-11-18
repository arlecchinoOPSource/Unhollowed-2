import { useId } from "react";
import "./charts.css";

/**
 * Shared chart for the dashboard widgets: bars or lines of one or more series
 * over the same labeled points. It draws values that an authoritative query
 * already computed; it never derives metrics. Every value is also in a table
 * that keyboard and screen-reader users can open, series differ by shape and
 * pattern as well as color, and an empty dataset looks different from an
 * unavailable one.
 */
export type Accent = "periwinkle" | "green" | "amber" | "violet";

export interface Point {
  /** What the point is, such as "12 Nov" or "Week of 10 Nov". */
  label: string;
  /** Null means no data for this point, which is not zero. */
  value: number | null;
}

export interface Series {
  name: string;
  accent: Accent;
  points: readonly Point[];
}

export interface ChartProps {
  kind: "bar" | "line";
  title: string;
  /** The period the points cover, in words, for the description. */
  range: string;
  /** Formats a value with its unit, for tooltips, axis, and table. */
  format: (value: number) => string;
  series: readonly Series[];
  /** A fixed top of the scale, such as 100 for percentages. */
  max?: number;
  state?: "ready" | "empty" | "unavailable";
  /** Said when empty or unavailable. */
  message?: string;
}

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 56 };
const MARKS = ["circle", "square", "diamond", "triangle"] as const;

function mark(shape: (typeof MARKS)[number], x: number, y: number) {
  const r = 4;
  switch (shape) {
    case "circle":
      return <circle cx={x} cy={y} r={r} />;
    case "square":
      return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} />;
    case "diamond":
      return (
        <polygon
          points={`${x},${y - r - 1} ${x + r + 1},${y} ${x},${y + r + 1} ${x - r - 1},${y}`}
        />
      );
    default:
      return (
        <polygon
          points={`${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`}
        />
      );
  }
}

export function Chart({
  kind,
  title,
  range,
  format,
  series,
  max,
  state = "ready",
  message,
}: ChartProps) {
  const id = useId();
  if (state !== "ready")
    return (
      <div className="chart-state" data-chart-state={state} role="status">
        <strong>{title}</strong>
        <p>
          {message ??
            (state === "empty"
              ? "No data in this period."
              : "This chart does not apply here.")}
        </p>
      </div>
    );

  const count = Math.max(...series.map((s) => s.points.length), 1);
  const values = series.flatMap((s) =>
    s.points.flatMap((p) => (p.value === null ? [] : [p.value])),
  );
  const top = max ?? Math.max(1, ...values);
  const inner = W - PAD.left - PAD.right;
  const base = H - PAD.bottom;
  const scale = (base - PAD.top) / top;
  const slot = inner / count;
  const labels = series[0]?.points ?? [];
  const peak = values.length ? Math.max(...values) : 0;
  const description = `${title}, ${range}. ${series
    .map((s) => s.name)
    .join(
      ", ",
    )}. Highest value ${format(peak)}. The values are in a table below.`;

  return (
    <figure className="chart" data-chart={kind}>
      <figcaption>
        <strong>{title}</strong> <span className="chart-range">{range}</span>
      </figcaption>
      <ul className="chart-legend" aria-label="Legend">
        {series.map((s, index) => (
          <li key={s.name}>
            <svg width="22" height="12" aria-hidden="true">
              <g
                className={`chart-series chart-${s.accent}`}
                data-pattern={index}
              >
                {kind === "bar" ? (
                  <rect x="1" y="1" width="20" height="10" />
                ) : (
                  <>
                    <line x1="0" y1="6" x2="22" y2="6" />
                    {mark(MARKS[index % MARKS.length], 11, 6)}
                  </>
                )}
              </g>
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={description}
        className="chart-svg"
      >
        <defs>
          <pattern
            id={`${id}-stripe`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" className="chart-stripe" />
          </pattern>
        </defs>
        <g className="chart-axes" aria-hidden="true">
          {[0, top].map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={base - tick * scale}
                y2={base - tick * scale}
              />
              <text
                x={PAD.left - 6}
                y={base - tick * scale + 4}
                textAnchor="end"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={H - 6}>
            {labels[0]?.label}
          </text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end">
            {labels[labels.length - 1]?.label}
          </text>
        </g>
        {series.map((s, si) => {
          const cx = (i: number) =>
            PAD.left +
            (kind === "bar"
              ? i * slot + slot / 2
              : count === 1
                ? inner / 2
                : (i * inner) / (count - 1));
          const barWidth = Math.max(Math.min(slot / series.length - 1, 24), 1);
          const runs: { x: number; y: number }[][] = [[]];
          s.points.forEach((p, i) => {
            if (p.value === null) runs.push([]);
            else
              runs[runs.length - 1].push({
                x: cx(i),
                y: base - p.value * scale,
              });
          });
          return (
            <g
              key={s.name}
              className={`chart-series chart-${s.accent}`}
              data-series={s.name}
            >
              {kind === "line" &&
                runs
                  .filter((run) => run.length > 1)
                  .map((run, i) => (
                    <polyline
                      key={i}
                      className="chart-line"
                      fill="none"
                      strokeDasharray={
                        si === 0 ? undefined : si === 1 ? "6 3" : "2 3"
                      }
                      points={run.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                    />
                  ))}
              {s.points.map((p, i) => {
                const label = `${p.label}: ${p.value === null ? "no data" : format(p.value)} (${s.name})`;
                if (p.value === null) return null;
                if (kind === "line")
                  return (
                    <g key={i} className="chart-mark">
                      {mark(
                        MARKS[si % MARKS.length],
                        cx(i),
                        base - p.value * scale,
                      )}
                      <title>{label}</title>
                    </g>
                  );
                const height = Math.max(p.value * scale, p.value === 0 ? 0 : 2);
                const x =
                  cx(i) - (barWidth * series.length) / 2 + si * barWidth;
                return (
                  <g key={i} className="chart-mark">
                    <rect
                      className="chart-bar"
                      x={x}
                      y={base - height}
                      width={barWidth}
                      height={height}
                    />
                    {si % 2 === 1 && (
                      <rect
                        x={x}
                        y={base - height}
                        width={barWidth}
                        height={height}
                        fill={`url(#${id}-stripe)`}
                      />
                    )}
                    <title>{label}</title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <details className="chart-table">
        <summary>Show values ({labels.length})</summary>
        <div className="chart-table-scroll">
          <table>
            <caption className="visually-hidden">{description}</caption>
            <thead>
              <tr>
                <th scope="col">Point</th>
                {series.map((s) => (
                  <th scope="col" key={s.name}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((point, i) => (
                <tr key={point.label + i}>
                  <th scope="row">{point.label}</th>
                  {series.map((s) => (
                    <td key={s.name}>
                      {s.points[i]?.value == null
                        ? "No data"
                        : format(s.points[i].value as number)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
