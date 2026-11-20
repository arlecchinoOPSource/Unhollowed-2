/**
 * The one record kept across an update's restart (U2-P7-06): the version
 * being installed and the page to return to. It holds no workspace data, and
 * it is read once and removed on the next start.
 */
export interface UpdateResume {
  version: string;
  path: string;
}

const KEY = "unhollowed-2-update-resume";

export function rememberUpdate(resume: UpdateResume) {
  try {
    localStorage.setItem(KEY, JSON.stringify(resume));
  } catch {
    // Without it the app still starts normally; it only skips the notice.
  }
}

export function forgetUpdate() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Returns the record once and removes it, so it is never acted on twice. */
export function takeUpdateResume(): UpdateResume | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<UpdateResume>) : null;
    return typeof value?.version === "string" &&
      typeof value.path === "string" &&
      value.path.startsWith("/")
      ? { version: value.version, path: value.path }
      : null;
  } catch {
    return null;
  }
}
