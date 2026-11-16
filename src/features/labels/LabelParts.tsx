import type { CSSProperties } from "react";
import {
  labelColors,
  type Label,
  type LabelColor,
} from "../../database/labels";
import "./labels.css";

export function swatchStyle(color: LabelColor): CSSProperties {
  const { light, dark } = labelColors[color];
  return { "--label-light": light, "--label-dark": dark } as CSSProperties;
}

/**
 * A label's name with its color as a small swatch. The name is always shown,
 * and archived labels say so in text.
 */
export function LabelBadge({ label }: { label: Label }) {
  return (
    <span
      className={`label-badge${label.archived ? " label-archived" : ""}`}
      title={label.description ?? undefined}
    >
      <span
        className="label-dot"
        style={swatchStyle(label.color)}
        aria-hidden="true"
      />
      {label.name}
      {label.archived && <span className="label-state">archived</span>}
    </span>
  );
}

/** Badges for the given IDs in name order, skipping unknown IDs. */
export function LabelBadges({
  ids,
  labels,
}: {
  ids: string[];
  labels: Map<string, Label>;
}) {
  const shown = ids
    .map((id) => labels.get(id))
    .filter((label): label is Label => Boolean(label))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (shown.length === 0) return null;
  return (
    <ul className="label-badges" aria-label="Labels">
      {shown.map((label) => (
        <li key={label.id}>
          <LabelBadge label={label} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Checkbox selection of labels. Active labels can be chosen. Archived labels
 * appear only while selected, so they can be kept or removed but not added.
 */
export function LabelPicker({
  legend,
  labels,
  selected,
  onChange,
  allowArchived = false,
  retained = [],
}: {
  legend: string;
  labels: Label[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Filters may pick archived labels to find historical issues. */
  allowArchived?: boolean;
  /**
   * Archived labels to keep listed after they are unchecked, so focus is not
   * lost. They cannot be checked again while archived.
   */
  retained?: string[];
}) {
  const options = labels.filter(
    (label) =>
      !label.archived ||
      allowArchived ||
      selected.includes(label.id) ||
      retained.includes(label.id),
  );
  return (
    <fieldset className="label-picker">
      <legend>{legend}</legend>
      {options.length === 0 ? (
        <p>No labels yet.</p>
      ) : (
        options.map((label) => {
          const checked = selected.includes(label.id);
          const locked = label.archived && !allowArchived && !checked;
          return (
            <label key={label.id}>
              <input
                type="checkbox"
                checked={checked}
                aria-disabled={locked || undefined}
                aria-describedby={locked ? "archived-label-note" : undefined}
                onChange={() =>
                  !locked &&
                  onChange(
                    checked
                      ? selected.filter((id) => id !== label.id)
                      : [...selected, label.id],
                  )
                }
              />
              <LabelBadge label={label} />
            </label>
          );
        })
      )}
      {!allowArchived && options.some((label) => label.archived) && (
        <p id="archived-label-note" className="label-note">
          Archived labels can be removed but not added.
        </p>
      )}
    </fieldset>
  );
}
