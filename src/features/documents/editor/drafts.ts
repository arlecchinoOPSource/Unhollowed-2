import { updateDocument } from "../../../database/documents";

export interface Draft {
  title: string;
  content: string;
}

const savingById = new Map<string, Promise<unknown>>();
const drafts = new Map<string, Draft>();

function key(id: string) {
  return `unhollowed-2-document-draft:${id}`;
}

export function readDraft(id: string): Draft | undefined {
  const current = drafts.get(id);
  if (current) return current;
  try {
    const raw = localStorage.getItem(key(id));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<Draft>;
      if (
        typeof draft.title === "string" &&
        typeof draft.content === "string"
      ) {
        return { title: draft.title, content: draft.content };
      }
    }
  } catch {
    // A missing or invalid journal must not hide the saved document.
  }
}

export function journalDraft(id: string, draft: Draft): boolean {
  drafts.set(id, draft);
  try {
    localStorage.setItem(key(id), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function discardDraft(id: string, snapshot: Draft) {
  const current = readDraft(id);
  if (current?.title !== snapshot.title || current.content !== snapshot.content)
    return;
  drafts.delete(id);
  try {
    localStorage.removeItem(key(id));
  } catch {
    // A later open compares the journal with the saved content.
  }
}

export async function waitForDocumentWrites(id: string) {
  await savingById.get(id);
}

export function saveDocumentDraft(id: string, draft: Draft) {
  const result = Promise.resolve(savingById.get(id)).then(() =>
    updateDocument(id, draft.title.trim() || "Untitled", draft.content),
  );
  const pending = result.then(
    () => discardDraft(id, draft),
    () => undefined,
  );
  savingById.set(id, pending);
  void pending.then(() => {
    if (savingById.get(id) === pending) savingById.delete(id);
  });
  return result;
}

/**
 * Saves every edit not yet stored and waits for all document writes, before
 * the app hands over to an installer (U2-P7-06). Rejects if any save fails,
 * so nothing is installed while a document is unsaved.
 */
export async function flushDocumentWrites() {
  await Promise.all(
    [...drafts].map(([id, draft]) => saveDocumentDraft(id, draft)),
  );
  await Promise.all(savingById.values());
}
