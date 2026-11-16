export function isIssueShortcut(event: KeyboardEvent, code: string) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    !event.altKey ||
    !event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.code !== code
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
