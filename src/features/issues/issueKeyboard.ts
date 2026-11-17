/**
 * Whether an Alt/Option+Shift shortcut may run: no other modifier, not while
 * typing, and not behind a modal dialog. Every app shortcut shares this, so
 * none can fire inside a field or over a dialog.
 */
export function shortcutAllowed(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    !event.altKey ||
    !event.shiftKey ||
    event.metaKey ||
    event.ctrlKey
  )
    return false;
  if (
    document.querySelector("dialog:modal, [role='dialog'][aria-modal='true']")
  )
    return false;
  return !(
    event.target instanceof HTMLElement &&
    event.target.closest(
      "input, textarea, select, [contenteditable], [role='textbox']",
    )
  );
}

export function isIssueShortcut(event: KeyboardEvent, code: string) {
  return event.code === code && shortcutAllowed(event);
}
