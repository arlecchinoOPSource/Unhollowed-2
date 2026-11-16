import { useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { findText, type Match } from "./textSearch";

export function DocumentNavigation({ editor }: { editor: Editor }) {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [feedback, setFeedback] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const document = useEditorState({
    editor,
    selector: ({ editor }) => editor.state.doc,
    equalityFn: (a, b) => a === b,
  });
  const text = document.textBetween(0, document.content.size, "\n");
  const words = text.match(/\S+/gu)?.length ?? 0;
  const matches = findText(document, query);

  const headings: { position: number; label: string; level: number }[] = [];
  document.descendants((node, position) => {
    if (node.type.name === "heading" && node.textContent.trim()) {
      headings.push({
        position,
        label: node.textContent,
        level: node.attrs.level,
      });
    }
  });

  useEffect(() => {
    if (showSearch) field.current?.focus();
  }, [showSearch]);

  function next() {
    const current = editor.state.selection;
    return matches.find(({ from }) => from >= current.to) ?? matches[0];
  }

  function select(match: Match | undefined) {
    if (match)
      editor.chain().focus().setTextSelection(match).scrollIntoView().run();
  }

  function replace(all: boolean) {
    const { from, to } = editor.state.selection;
    const selected =
      matches.find((match) => match.from === from && match.to === to) ?? next();
    const targets = all ? matches : selected ? [selected] : [];
    if (!targets.length) return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        for (const match of [...targets].reverse()) {
          tr.insertText(replacement, match.from, match.to);
        }
        return true;
      })
      .run();
    setFeedback(
      `Replaced ${targets.length} ${targets.length === 1 ? "match" : "matches"}.`,
    );
  }

  function closeSearch() {
    setShowSearch(false);
    searchButton.current?.focus();
  }

  return (
    <div className="document-navigation">
      <div className="word-controls">
        <button
          ref={searchButton}
          type="button"
          aria-expanded={showSearch}
          onClick={() => setShowSearch(!showSearch)}
        >
          Find &amp; replace
        </button>
        <span>
          {words} {words === 1 ? "word" : "words"} · {Array.from(text).length}{" "}
          characters
        </span>
      </div>
      {showSearch && (
        <form
          className="word-controls"
          onSubmit={(event) => {
            event.preventDefault();
            select(next());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeSearch();
            }
          }}
        >
          <label>
            Find
            <input
              ref={field}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setFeedback("");
              }}
            />
          </label>
          <label>
            Replace with
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!matches.length}>
            Next match
          </button>
          <button
            type="button"
            disabled={!matches.length}
            onClick={() => replace(false)}
          >
            Replace match
          </button>
          <button
            type="button"
            disabled={!matches.length}
            onClick={() => replace(true)}
          >
            Replace all
          </button>
          <button type="button" onClick={closeSearch}>
            Close find
          </button>
          <p aria-live="polite">
            {feedback ||
              (query &&
                `${matches.length} ${matches.length === 1 ? "match" : "matches"}`)}
          </p>
        </form>
      )}
      <details className="word-more">
        <summary>Heading outline</summary>
        {headings.length === 0 ? (
          <p>Add headings to navigate your document.</p>
        ) : (
          <ol className="document-outline">
            {headings.map(({ position, label, level }) => (
              <li key={position}>
                <button
                  type="button"
                  onClick={() =>
                    editor
                      .chain()
                      .focus()
                      .setTextSelection(position + 1)
                      .scrollIntoView()
                      .run()
                  }
                >
                  <span aria-hidden="true">H{level} · </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
