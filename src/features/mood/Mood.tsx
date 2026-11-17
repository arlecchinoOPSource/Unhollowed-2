import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  checkinError,
  deleteCheckin,
  getCheckin,
  listCheckins,
  saveCheckin,
  type Checkin,
} from "../../database/checkins";
import { isTauri } from "../../database/status";
import { fullDate } from "../calendar/monthGrid";
import { localDate } from "../today/dates";
import { MoodTrends } from "./MoodTrends";
import "./mood.css";

type Rating = number | null;
interface Draft {
  mood: Rating;
  energy: Rating;
  focus: Rating;
  note: string;
}

const EMPTY: Draft = { mood: null, energy: null, focus: null, note: "" };
const SCALES = [
  { key: "mood", label: "Mood", low: "very low", high: "very good" },
  { key: "energy", label: "Energy", low: "very low", high: "very high" },
  { key: "focus", label: "Focus", low: "scattered", high: "very focused" },
] as const;

const draftOf = (checkin: Checkin | null): Draft =>
  checkin
    ? {
        mood: checkin.mood,
        energy: checkin.energy,
        focus: checkin.focus,
        note: checkin.note ?? "",
      }
    : EMPTY;

const same = (a: Draft, b: Draft) =>
  a.mood === b.mood &&
  a.energy === b.energy &&
  a.focus === b.focus &&
  a.note.trim() === b.note.trim();

const rating = (value: Rating) =>
  value === null ? "not set" : `${value} of 5`;

/**
 * A quick, optional daily check-in: three 1 to 5 ratings and a note. A rating
 * the user does not choose stays "Not set". Saving with nothing in the form
 * removes that day's check-in. A failed save keeps the draft. Notes appear
 * only for the selected day, never in the history list.
 */
export function Mood() {
  const desktop = isTauri();
  const today = localDate(new Date());
  const [date, setDate] = useState(today);
  const [saved, setSaved] = useState<Checkin | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [recent, setRecent] = useState<Checkin[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    Promise.all([
      getCheckin(date),
      listCheckins(localDate(new Date(), -59), today),
    ])
      .then(([checkin, list]) => {
        if (!live) return;
        setSaved(checkin);
        setDraft(draftOf(checkin));
        setRecent([...list].reverse());
        setLoaded(true);
        setLoadError("");
      })
      .catch((cause) => {
        if (!live) return;
        setLoadError(checkinError(cause));
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [desktop, date, today, reload]);

  const dirty = !same(draft, draftOf(saved));

  /** Moves to another day, but never silently drops an unsaved draft. */
  const go = useCallback(
    (next: string) => {
      if (next > today || next < "1900-01-01" || next === date) return;
      if (dirty) {
        setStatus("");
        setError("Save or discard your changes before choosing another day.");
        return;
      }
      setError("");
      setStatus("");
      setLoaded(false);
      setDate(next);
    },
    [dirty, date, today],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await saveCheckin(date, {
        mood: draft.mood,
        energy: draft.energy,
        focus: draft.focus,
        note: draft.note.trim() || null,
      });
      setSaved(result);
      setDraft(draftOf(result));
      setStatus(
        result
          ? `Saved your check-in for ${fullDate(date)}.`
          : saved
            ? `Removed the check-in for ${fullDate(date)}, because nothing was left in it.`
            : `Nothing to save for ${fullDate(date)}. Choose a rating or write a note.`,
      );
      setReload((count) => count + 1);
    } catch (cause) {
      // The draft stays exactly as typed.
      setStatus("");
      setError(checkinError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !saved) return;
    setBusy(true);
    setError("");
    try {
      await deleteCheckin(date);
      setSaved(null);
      setDraft(EMPTY);
      setStatus(`Deleted the check-in for ${fullDate(date)}.`);
      setReload((count) => count + 1);
    } catch (cause) {
      setStatus("");
      setError(checkinError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mood-view">
      <h1>Mood</h1>
      <p>
        A quick, optional check-in. Everything here is private to this device
        and optional: leave out anything you would rather not say.
      </p>
      {!desktop && <p>Open the desktop app to record check-ins.</p>}
      {desktop && (
        <>
          <div className="mood-date" role="group" aria-label="Day">
            <button
              type="button"
              className="action"
              aria-label="Previous day"
              onClick={() => go(localDate(new Date(`${date}T12:00:00`), -1))}
            >
              ‹
            </button>
            <label>
              Date
              <input
                type="date"
                value={date}
                max={today}
                min="1900-01-01"
                onChange={(event) =>
                  event.target.value && go(event.target.value)
                }
              />
            </label>
            <button
              type="button"
              className="action"
              aria-label="Next day"
              disabled={date >= today}
              onClick={() => go(localDate(new Date(`${date}T12:00:00`), 1))}
            >
              ›
            </button>
            <button
              type="button"
              className="action"
              disabled={date === today}
              onClick={() => go(today)}
            >
              Today
            </button>
          </div>
          <h2>{fullDate(date)}</h2>
          {loaded && !saved && !dirty && <p>No check-in for this day yet.</p>}
          <form onSubmit={submit} aria-label="Check-in" className="mood-form">
            {SCALES.map(({ key, label, low, high }) => (
              <fieldset key={key} disabled={busy || !loaded}>
                <legend>
                  {label}{" "}
                  <small>
                    1 is {low}, 5 is {high}
                  </small>
                </legend>
                {([null, 1, 2, 3, 4, 5] as const).map((value) => (
                  <label key={String(value)} className="mood-choice">
                    <input
                      type="radio"
                      name={key}
                      checked={draft[key] === value}
                      onChange={() => setDraft({ ...draft, [key]: value })}
                    />
                    <span>{value === null ? "Not set" : value}</span>
                  </label>
                ))}
              </fieldset>
            ))}
            <label className="mood-note">
              Note (optional)
              <textarea
                value={draft.note}
                maxLength={2000}
                rows={4}
                disabled={busy || !loaded}
                onChange={(event) =>
                  setDraft({ ...draft, note: event.target.value })
                }
              />
            </label>
            <p className="mood-hint">
              Saving with every rating “Not set” and no note removes this day’s
              check-in.
            </p>
            <div className="mood-actions">
              <button
                type="submit"
                className="action"
                disabled={busy || !loaded || (!dirty && !saved)}
              >
                {saved ? "Save changes" : "Save check-in"}
              </button>
              {dirty && (
                <button
                  type="button"
                  className="action"
                  disabled={busy}
                  onClick={() => {
                    setDraft(draftOf(saved));
                    setError("");
                  }}
                >
                  Discard changes
                </button>
              )}
              {saved && (
                <button
                  type="button"
                  className="action"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete check-in
                </button>
              )}
            </div>
          </form>
        </>
      )}
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      {loadError && (
        <div role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            className="action"
            onClick={() => setReload((count) => count + 1)}
          >
            Retry loading
          </button>
        </div>
      )}

      {desktop && <MoodTrends reload={reload} />}

      {desktop && (
        <section aria-labelledby="mood-history">
          <h2 id="mood-history">Recent check-ins</h2>
          {recent.length === 0 ? (
            <p>No check-ins in the last 60 days.</p>
          ) : (
            <ul className="mood-recent">
              {recent.map((checkin) => (
                <li key={checkin.id}>
                  <button
                    type="button"
                    aria-current={checkin.date === date ? "date" : undefined}
                    onClick={() => go(checkin.date)}
                  >
                    {fullDate(checkin.date)}
                  </button>{" "}
                  Mood {rating(checkin.mood)}, energy {rating(checkin.energy)},
                  focus {rating(checkin.focus)}
                  {checkin.note ? ", has a note" : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
