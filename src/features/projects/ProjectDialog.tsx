import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  projectError,
  type Project,
  type ProjectInput,
} from "../../database/projects";

export function ProjectDialog({
  project,
  save,
  onClose,
}: {
  project?: Project;
  save: (input: ProjectInput) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    name.current?.focus();
    return () => element.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const input: ProjectInput = {
      name: String(form.get("name")).trim(),
      description: String(form.get("description")).trim() || null,
      startDate: String(form.get("startDate")) || null,
      targetDate: String(form.get("targetDate")) || null,
    };
    if (!input.name) {
      setError("Enter a project name.");
      name.current?.focus();
      return;
    }
    if (
      input.startDate &&
      input.targetDate &&
      input.startDate > input.targetDate
    ) {
      setError("The target date must be on or after the start date.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await save(input);
      onClose();
    } catch (cause) {
      setError(projectError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="project-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="project-dialog-title">
          {project ? "Edit project" : "Create project"}
        </h2>
        <fieldset disabled={saving}>
          <label>
            Project name
            <input
              ref={name}
              name="name"
              required
              maxLength={200}
              defaultValue={project?.name}
            />
          </label>
          <label>
            Description <span>(optional)</span>
            <textarea
              name="description"
              rows={4}
              maxLength={5000}
              defaultValue={project?.description ?? ""}
            />
          </label>
          <div className="project-dates">
            <label>
              Start date <span>(optional)</span>
              <input
                type="date"
                name="startDate"
                defaultValue={project?.startDate ?? ""}
              />
            </label>
            <label>
              Target date <span>(optional)</span>
              <input
                type="date"
                name="targetDate"
                defaultValue={project?.targetDate ?? ""}
              />
            </label>
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <div className="project-actions">
          <button
            type="button"
            className="project-secondary"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="action" disabled={saving}>
            {saving ? "Saving…" : project ? "Save changes" : "Create project"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
