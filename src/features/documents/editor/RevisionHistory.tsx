import { useEffect, useState } from "react";
import {
  listDocumentRevisions,
  type DocumentRevision,
} from "../../../database/documents";

export function RevisionHistory({
  id,
  disabled,
  restore,
}: {
  id: string;
  disabled: boolean;
  restore: (id: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<DocumentRevision[]>();
  const [selected, setSelected] = useState<DocumentRevision>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let current = true;
    listDocumentRevisions(id).then(
      (items) => {
        if (current) setRevisions(items);
      },
      () => {
        if (current)
          setError(
            "Could not load version history. Close and reopen it to retry.",
          );
      },
    );
    return () => {
      current = false;
    };
  }, [id, open, disabled]);

  return (
    <details
      className="word-more"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        setError("");
      }}
    >
      <summary>Version history</summary>
      {!revisions && !error && <p>Loading versions…</p>}
      {revisions?.length === 0 && <p>No earlier versions yet.</p>}
      {revisions && revisions.length > 0 && (
        <ul className="document-revisions">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <span>
                {revision.title} ·{" "}
                <time dateTime={revision.savedAt}>
                  {new Date(revision.savedAt).toLocaleString()}
                </time>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setSelected(revision)}
              >
                Choose version
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div className="word-controls">
          <p>
            Restore “{selected.title}”? Your current version will be saved in
            history.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setError("");
              void restore(selected.id).catch(() =>
                setError("Could not restore this version. Try again."),
              );
            }}
          >
            Restore version
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setSelected(undefined)}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
