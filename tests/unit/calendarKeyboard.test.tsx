import { afterEach, describe, expect, it } from "vitest";
import { shortcutAction } from "../../src/features/calendar/calendarKeyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Dispatches a key on `target` and returns what the calendar makes of it. */
function press(
  code: string,
  init: KeyboardEventInit = { altKey: true, shiftKey: true },
  target: Element = document.body,
) {
  let result: ReturnType<typeof shortcutAction> = null;
  const listener = (event: Event) => {
    result = shortcutAction(event as KeyboardEvent);
  };
  window.addEventListener("keydown", listener);
  target.dispatchEvent(
    new KeyboardEvent("keydown", { code, bubbles: true, ...init }),
  );
  window.removeEventListener("keydown", listener);
  return result;
}

describe("calendar shortcuts", () => {
  it("map Alt/Option+Shift keys to calendar actions", () => {
    expect(press("KeyT")).toEqual({ type: "today" });
    expect(press("Comma")).toEqual({ type: "step", direction: -1 });
    expect(press("Period")).toEqual({ type: "step", direction: 1 });
    expect(press("KeyG")).toEqual({ type: "goto" });
    expect(press("KeyS")).toEqual({ type: "search" });
    expect(press("KeyE")).toEqual({ type: "new" });
    expect(press("Digit1")).toEqual({ type: "view", view: "day" });
    expect(press("Digit3")).toEqual({ type: "view", view: "workweek" });
    expect(press("Digit5")).toEqual({ type: "view", view: "agenda" });
  });

  it("leave the keys Issues uses, and unmapped keys, alone", () => {
    expect(press("KeyN")).toBeNull();
    expect(press("KeyF")).toBeNull();
    expect(press("Digit6")).toBeNull();
    expect(press("KeyZ")).toBeNull();
  });

  it("need exactly Alt/Option and Shift, so typing and system keys pass", () => {
    expect(press("KeyT", {})).toBeNull();
    expect(press("KeyT", { altKey: true })).toBeNull();
    expect(press("KeyT", { shiftKey: true })).toBeNull();
    expect(
      press("KeyT", { altKey: true, shiftKey: true, metaKey: true }),
    ).toBeNull();
    expect(
      press("KeyT", { altKey: true, shiftKey: true, ctrlKey: true }),
    ).toBeNull();
    expect(
      press("KeyT", { altKey: true, shiftKey: true, repeat: true }),
    ).toBeNull();
  });

  it("are ignored in editable fields and behind modal dialogs", () => {
    for (const html of [
      "<input id='t'>",
      "<textarea id='t'></textarea>",
      "<select id='t'></select>",
      "<div id='t' contenteditable='true'></div>",
      "<div id='t' role='textbox'></div>",
    ]) {
      document.body.innerHTML = html;
      expect(
        press("KeyT", undefined, document.getElementById("t")!),
      ).toBeNull();
    }
    document.body.innerHTML =
      "<div role='dialog' aria-modal='true'></div><button id='t'></button>";
    expect(press("KeyT", undefined, document.getElementById("t")!)).toBeNull();
  });
});
