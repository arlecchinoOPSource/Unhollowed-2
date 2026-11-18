import { useEffect, useRef, useState } from "react";
import { presets, type Period, type Preset } from "./controls";
import { GRID, newWidgetId } from "./layout";
import type { PlacedWidget } from "./layout";

export { newWidgetId };
import { WidgetHost, hasRenderer, type WidgetContext } from "./WidgetHost";
import {
  DESTINATIONS,
  MAX_SHORTCUTS,
  widgetDefinition,
  widgetTypes,
  type FieldSpec,
  type PeriodOverride,
  type Shortcut,
  type WidgetDefinition,
} from "./widgets";

/** A new widget placed below everything, with the type's defaults. */
export function newWidget(
  definition: WidgetDefinition,
  existing: readonly PlacedWidget[],
): PlacedWidget {
  return {
    id: newWidgetId(definition.type, existing),
    type: definition.type,
    version: definition.version,
    config: definition.defaults,
    hidden: false,
    x: 0,
    y: existing.reduce((end, item) => Math.max(end, item.y + item.h), 0),
    w: Math.min(definition.size.w, GRID),
    h: definition.size.h,
  };
}

/** A modal dialog; the browser returns focus to the opener when it closes. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dash-dialog"
      aria-labelledby="dash-dialog-title"
      onClose={onClose}
    >
      <h2 id="dash-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}

/**
 * Browse the widgets this build can show, preview each with the real widget
 * (same component and same data path as on the dashboard), and add one.
 */
export function WidgetLibrary({
  context,
  onAdd,
  onClose,
}: {
  context: WidgetContext;
  onAdd: (definition: WidgetDefinition) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const ready = widgetTypes.filter(({ type }) => hasRenderer(type));
  const later = widgetTypes.filter(({ type }) => !hasRenderer(type));
  return (
    <Modal title="Add a widget" onClose={onClose}>
      <ul className="dash-library">
        {ready.map((definition) => (
          <li key={definition.type}>
            <h3>{definition.label}</h3>
            <p>{definition.description}</p>
            <div className="dash-library-actions">
              <button
                type="button"
                className="action"
                aria-pressed={preview === definition.type}
                aria-label={`Preview ${definition.label}`}
                onClick={() =>
                  setPreview(
                    preview === definition.type ? null : definition.type,
                  )
                }
              >
                Preview
              </button>
              <button
                type="button"
                className="action"
                aria-label={`Add ${definition.label}`}
                onClick={() => {
                  onAdd(definition);
                  onClose();
                }}
              >
                Add
              </button>
            </div>
            {preview === definition.type && (
              <div className="dash-preview" data-preview={definition.type}>
                <WidgetHost
                  instance={{
                    id: "preview",
                    type: definition.type,
                    version: definition.version,
                    config: definition.defaults,
                  }}
                  context={context}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {later.length > 0 && (
        <p>Not available yet: {later.map(({ label }) => label).join(", ")}.</p>
      )}
      <button type="button" className="action" onClick={onClose}>
        Close
      </button>
    </Modal>
  );
}

type Draft = Record<string, unknown>;

function Field({
  spec,
  value,
  fallback,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  /** Dates offered when a custom period is first chosen. */
  fallback: Period;
  onChange: (value: unknown) => void;
}) {
  if (spec.kind === "textarea") {
    const text = typeof value === "string" ? value : "";
    return (
      <label className="dash-field">
        {spec.label}
        <textarea
          rows={5}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>
          {text.length} of {spec.max} characters
        </span>
      </label>
    );
  }
  if (spec.kind === "period") {
    const own = (value as PeriodOverride | undefined) ?? undefined;
    const choice = own?.preset ?? "";
    return (
      <fieldset className="dash-field">
        <legend>{spec.label}</legend>
        <label>
          Period for this widget
          <select
            value={choice}
            onChange={(event) => {
              const preset = event.target.value as Preset | "";
              onChange(
                preset === ""
                  ? undefined
                  : preset === "custom"
                    ? { preset, custom: own?.custom ?? fallback }
                    : { preset },
              );
            }}
          >
            <option value="">Same as the dashboard</option>
            {presets.map(({ value: preset, label }) => (
              <option key={preset} value={preset}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {own?.preset === "custom" &&
          (["from", "to"] as const).map((edge) => (
            <label key={edge}>
              {edge === "from" ? "From" : "To"}
              <input
                type="date"
                min="1900-01-01"
                value={own.custom?.[edge] ?? ""}
                onChange={(event) =>
                  onChange({
                    preset: "custom",
                    custom: {
                      ...(own.custom ?? fallback),
                      [edge]: event.target.value,
                    },
                  })
                }
              />
            </label>
          ))}
      </fieldset>
    );
  }
  if (spec.kind === "choice")
    return (
      <label className="dash-field">
        {spec.label}
        <select
          value={typeof value === "string" ? value : spec.options[0].value}
          onChange={(event) => onChange(event.target.value)}
        >
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  const links = Array.isArray(value) ? (value as Shortcut[]) : [];
  const chosen = new Set(links.map((link) => link.to));
  return (
    <fieldset className="dash-field">
      <legend>
        {spec.label} (up to {MAX_SHORTCUTS})
      </legend>
      {DESTINATIONS.map((destination) => (
        <label key={destination.to} className="dash-check">
          <input
            type="checkbox"
            checked={chosen.has(destination.to)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...links, destination]
                  : links.filter((link) => link.to !== destination.to),
              )
            }
          />
          <span>{destination.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Settings for one widget, generated from its registry fields. The draft is
 * checked with the same `parse` the saved layout uses, so Apply is possible
 * only for settings that would survive a restart.
 */
export function WidgetSettings({
  widget,
  period,
  onApply,
  onClose,
}: {
  widget: PlacedWidget;
  /** The dashboard's period, used to start a custom one. */
  period: Period;
  onApply: (config: object) => void;
  onClose: () => void;
}) {
  const definition = widgetDefinition(widget.type);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...(definition?.defaults ?? {}),
    ...(widget.config ?? {}),
  }));
  if (!definition?.fields)
    return (
      <Modal title="Settings" onClose={onClose}>
        <p>This widget has no settings.</p>
        <button type="button" className="action" onClick={onClose}>
          Close
        </button>
      </Modal>
    );
  const valid = definition.parse(draft);
  return (
    <Modal title={`Settings: ${definition.label}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onApply(valid);
        }}
      >
        {definition.fields.map((spec) => (
          <Field
            key={spec.key}
            spec={spec}
            value={draft[spec.key]}
            fallback={period}
            onChange={(value) => {
              const next = { ...draft, [spec.key]: value };
              if (value === undefined) delete next[spec.key];
              setDraft(next);
            }}
          />
        ))}
        {!valid && (
          <p role="alert">
            These settings are not valid, so they cannot be applied.
          </p>
        )}
        <div className="dash-library-actions">
          <button type="submit" className="action" disabled={!valid}>
            Apply
          </button>
          <button
            type="button"
            className="action"
            onClick={() => setDraft({ ...definition.defaults })}
          >
            Reset to defaults
          </button>
          <button type="button" className="action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
