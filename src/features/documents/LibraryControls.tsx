import { useState } from "react";
import type { JSONContent } from "@tiptap/react";
import type {
  Folder,
  LibraryChange,
  LibraryDocument,
} from "../../database/documentLibrary";

export const templates = {
  "Blank document": [],
  "Meeting notes": ["Attendees", "Agenda", "Decisions", "Action items"],
  "Research paper": [
    "Abstract",
    "Introduction",
    "Method",
    "Results",
    "Discussion",
    "References",
  ],
  "Business report": [
    "Executive summary",
    "Findings",
    "Recommendations",
    "Next steps",
  ],
  "Project proposal": [
    "Overview",
    "Objectives",
    "Scope",
    "Schedule",
    "Resources",
  ],
} as const;

export function templateBody(name: keyof typeof templates): JSONContent | null {
  const headings = templates[name];
  return headings.length === 0
    ? null
    : {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: headings.flatMap((heading) => [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: heading }],
          },
          { type: "paragraph" },
        ]),
      };
}

export function folderPath(id: string, folders: Folder[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let folder = folders.find((folder) => folder.id === id);
  while (folder && !seen.has(folder.id)) {
    parts.unshift(folder.name);
    seen.add(folder.id);
    folder = folders.find(({ id }) => id === folder?.parentId);
  }
  return parts.join(" / ");
}

export function LibraryControls({
  folders,
  selected,
  busy,
  addFolder,
  duplicate,
  update,
}: {
  folders: Folder[];
  selected?: LibraryDocument;
  busy: boolean;
  addFolder: (name: string, parent: string | null) => Promise<boolean>;
  duplicate: () => void;
  update: (input: LibraryChange) => void;
}) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const options = folders.map(({ id }) => (
    <option key={id} value={id}>
      {folderPath(id, folders)}
    </option>
  ));

  return (
    <details className="word-more">
      <summary>Organize documents</summary>
      <form
        className="word-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          void addFolder(name, parent || null).then((saved) => {
            if (saved) setName("");
          });
        }}
      >
        <label>
          New folder name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          Parent folder
          <select
            value={parent}
            onChange={(event) => setParent(event.target.value)}
          >
            <option value="">Top level</option>
            {options}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Create folder
        </button>
      </form>
      {selected && (
        <div
          className="word-controls"
          role="group"
          aria-label="Open document organization"
        >
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              update({ kind: "favorite", value: !selected.favorite })
            }
          >
            {selected.favorite ? "Remove favorite" : "Add favorite"}
          </button>
          <label>
            Move document
            <select
              disabled={busy}
              value={selected.folderId ?? ""}
              onChange={(event) =>
                update({ kind: "move", folder: event.target.value || null })
              }
            >
              <option value="">Top level</option>
              {options}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={duplicate}>
            Duplicate document
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              update({ kind: selected.archivedAt ? "restore" : "archive" })
            }
          >
            {selected.archivedAt ? "Restore document" : "Archive document"}
          </button>
          {selected.createdAt && (
            <p>
              Created {new Date(selected.createdAt).toLocaleDateString()} ·
              Updated {new Date(selected.updatedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
