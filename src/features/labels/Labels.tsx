import { ArrowLeft, Tags } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  archiveLabel,
  createLabel,
  labelColors,
  labelError,
  listLabels,
  restoreLabel,
  updateLabel,
  type Label,
  type LabelColor,
  type LabelInput,
} from "../../database/labels";
import { isTauri } from "../../database/status";
import { LabelBadge, swatchStyle } from "./LabelParts";

function LabelFields({
  idPrefix,
  initial,
  nameRef,
}: {
  idPrefix: string;
  initial?: LabelInput;
  nameRef?: React.Ref<HTMLInputElement>;
}) {
  const [color, setColor] = useState<LabelColor>(initial?.color ?? "blue");
  return (
    <>
      <label className="label-name-field">
        Label name
        <input
          ref={nameRef}
          name="name"
          required
          maxLength={50}
          defaultValue={initial?.name}
        />
      </label>
      <div className="label-color-field">
        <label htmlFor={`${idPrefix}-color`}>Color</label>
        <span>
          <span
            className="label-dot"
            style={swatchStyle(color)}
            aria-hidden="true"
          />
          <select
            id={`${idPrefix}-color`}
            name="color"
            value={color}
            onChange={(event) => setColor(event.target.value as LabelColor)}
          >
            {Object.entries(labelColors).map(([value, { name }]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </span>
      </div>
      <label className="label-description-field">
        Description (optional)
        <input
          name="description"
          maxLength={500}
          defaultValue={initial?.description ?? ""}
        />
      </label>
    </>
  );
}

function readInput(form: HTMLFormElement): LabelInput {
  const data = new FormData(form);
  return {
    name: String(data.get("name")).trim(),
    description: String(data.get("description")).trim() || null,
    color: String(data.get("color")) as LabelColor,
  };
}

export function Labels() {
  const desktop = isTauri();
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [request, setRequest] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const editName = useRef<HTMLInputElement>(null);
  const createName = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    listLabels().then(
      (loaded) => {
        if (current) setLabels(loaded);
      },
      (cause) => {
        if (current) setLoadError(labelError(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [desktop, request]);

  // Move focus once into an opened edit form, or back to the label a change
  // moved between the active and archived lists.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target =
      pendingFocus.current === "edit-form"
        ? editName.current
        : pendingFocus.current === "create-form"
          ? createName.current
          : buttons.current.get(pendingFocus.current);
    pendingFocus.current = null;
    target?.focus();
  });

  function replace(label: Label) {
    setLabels((current) =>
      (current ?? [])
        .map((item) => (item.id === label.id ? label : item))
        .sort(
          (a, b) =>
            Number(a.archived) - Number(b.archived) ||
            a.name.localeCompare(b.name),
        ),
    );
  }

  async function run(work: () => Promise<void>) {
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(labelError(cause));
    } finally {
      setSaving(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = readInput(form);
    void run(async () => {
      const label = await createLabel(input);
      setLabels((current) => [...(current ?? []), label]);
      replace(label);
      // The create form remounts empty; keep typing there for the next label.
      pendingFocus.current = "create-form";
      setFormKey((key) => key + 1);
      setMessage(`Created label ${label.name}.`);
    });
  }

  function save(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const input = readInput(event.currentTarget);
    void run(async () => {
      const label = await updateLabel(id, input);
      replace(label);
      setEditing(null);
      pendingFocus.current = `${id}:edit`;
      setMessage(`Saved label ${label.name}.`);
    });
  }

  function toggleArchived(label: Label) {
    void run(async () => {
      const changed = label.archived
        ? await restoreLabel(label.id)
        : await archiveLabel(label.id);
      replace(changed);
      pendingFocus.current = `${label.id}:archive`;
      setMessage(
        changed.archived
          ? `Archived ${changed.name}. It stays on existing issues.`
          : `Restored ${changed.name}.`,
      );
    });
  }

  function rows(items: Label[]) {
    return (
      <ul className="label-list">
        {items.map((label) =>
          editing === label.id ? (
            <li key={label.id} className="label-row">
              <form
                aria-label={`Edit ${label.name}`}
                onSubmit={(event) => save(event, label.id)}
              >
                <LabelFields
                  idPrefix={`edit-${label.id}`}
                  initial={label}
                  nameRef={editName}
                />
                <button className="action" type="submit">
                  {saving ? "Saving…" : "Save label"}
                </button>
                <button
                  type="button"
                  className="label-secondary"
                  onClick={() => {
                    setEditing(null);
                    pendingFocus.current = `${label.id}:edit`;
                  }}
                >
                  Cancel
                </button>
              </form>
            </li>
          ) : (
            <li key={label.id} className="label-row">
              <LabelBadge label={label} />
              <p>{label.description}</p>
              <Link to={`/issues?state=all&labels=${label.id}`}>
                {label.issueCount === 1
                  ? "1 issue"
                  : `${label.issueCount} issues`}
              </Link>
              <span className="label-row-actions">
                <button
                  type="button"
                  ref={(element) => {
                    if (element)
                      buttons.current.set(`${label.id}:edit`, element);
                  }}
                  aria-label={`Edit ${label.name}`}
                  onClick={() => {
                    pendingFocus.current = "edit-form";
                    setEditing(label.id);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  ref={(element) => {
                    if (element)
                      buttons.current.set(`${label.id}:archive`, element);
                  }}
                  aria-label={`${label.archived ? "Restore" : "Archive"} ${label.name}`}
                  aria-disabled={saving}
                  onClick={() => toggleArchived(label)}
                >
                  {label.archived ? "Restore" : "Archive"}
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
    );
  }

  const active = labels?.filter((label) => !label.archived) ?? [];
  const archived = labels?.filter((label) => label.archived) ?? [];

  return (
    <section className="labels-view">
      <Link className="issue-back" to="/issues">
        <ArrowLeft size={16} aria-hidden="true" /> All issues
      </Link>
      <h1>Labels</h1>
      <p>Group issues by themes that stay useful across projects.</p>
      {!desktop && <p>Open the desktop app to manage your local labels.</p>}
      {desktop && (
        <form
          key={formKey}
          aria-label="Create a label"
          className="label-create"
          onSubmit={create}
        >
          <LabelFields idPrefix="new-label" nameRef={createName} />
          <button className="action" type="submit" aria-disabled={saving}>
            Create label
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="issue-message">
        {message}
      </p>
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            className="action"
            onClick={() => {
              setLoadError("");
              setRequest(request + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {desktop && !loadError && labels === null && <p>Loading labels…</p>}
      {labels?.length === 0 && (
        <div className="issues-empty">
          <Tags size={24} aria-hidden="true" />
          <h2>No labels yet</h2>
          <p>Create a label to group related issues.</p>
        </div>
      )}
      {active.length > 0 && (
        <>
          <h2>Active labels</h2>
          {rows(active)}
        </>
      )}
      {archived.length > 0 && (
        <>
          <h2>Archived labels</h2>
          <p>
            Archived labels stay on existing issues and in filters, but cannot
            be added to more issues.
          </p>
          {rows(archived)}
        </>
      )}
    </section>
  );
}
