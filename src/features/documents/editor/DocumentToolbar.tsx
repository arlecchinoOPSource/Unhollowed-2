import { useEditorState, type Editor } from "@tiptap/react";
import { useId, useState } from "react";
import { FormattingToolbar } from "../../../components/editor/RichText";
import {
  fonts,
  highlights,
  inks,
  paragraphs,
  safeWebLink,
  sizes,
} from "./schema";

const emphasis = [
  ["underline", "Underline", "U"],
  ["strike", "Strikethrough", "S"],
  ["superscript", "Superscript", "x²"],
  ["subscript", "Subscript", "x₂"],
] as const;

export function DocumentToolbar({ editor }: { editor: Editor }) {
  const [editingLink, setEditingLink] = useState(false);
  const [url, setUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const fields = useId();

  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      heading:
        ([1, 2, 3, 4, 5, 6] as const).find((level) =>
          editor.isActive("heading", { level }),
        ) ?? 0,

      blockStyle: editor.getAttributes(
        editor.isActive("heading") ? "heading" : "paragraph",
      ),
      inlineStyle: editor.getAttributes("documentInlineStyle"),
      marks: emphasis.map(([name]) => editor.isActive(name)),
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      link: editor.isActive("link"),
      hasSelection: !editor.state.selection.empty,
    }),
  });

  function updateInline(name: string, value: string) {
    editor
      .chain()
      .focus()
      .setMark("documentInlineStyle", { [name]: value || null })
      .run();
  }

  const choices = [
    ["font", "Font family", fonts],
    [
      "size",
      "Font size",
      Object.fromEntries(sizes.map((size) => [size, `${size} pt`])),
    ],
    ["ink", "Text color", inks],
    ["highlight", "Highlight", highlights],
  ] as const;

  return (
    <div className="word-tools">
      <div className="word-controls" role="group" aria-label="Typography">
        <label>
          Style
          <select
            value={active.heading}
            onChange={(event) => {
              const level = Number(event.target.value) as
                0 | 1 | 2 | 3 | 4 | 5 | 6;
              if (level) editor.chain().focus().setHeading({ level }).run();
              else editor.chain().focus().setParagraph().run();
            }}
          >
            <option value={0}>Normal</option>
            {([1, 2, 3, 4, 5, 6] as const).map((level) => (
              <option key={level} value={level}>
                Heading {level}
              </option>
            ))}
          </select>
        </label>
        {choices.map(([name, label, options]) => (
          <label key={name}>
            {label}
            <select
              value={active.inlineStyle[name] ?? ""}
              onChange={(event) => updateInline(name, event.target.value)}
            >
              <option value="">Default</option>
              {Object.entries(options).map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <FormattingToolbar editor={editor} />
      <div className="word-controls" role="group" aria-label="Editing tools">
        {emphasis.map(([name, label, glyph], index) => (
          <button
            key={name}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={active.marks[index]}
            onClick={() => editor.chain().focus().toggleMark(name).run()}
          >
            {glyph}
          </button>
        ))}
        <button
          type="button"
          disabled={!active.canUndo}
          onClick={() => editor.chain().focus().undo().run()}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!active.canRedo}
          onClick={() => editor.chain().focus().redo().run()}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={() =>
            editor
              .chain()
              .focus()
              .unsetAllMarks()
              .clearNodes()
              .resetAttributes("paragraph", Object.keys(paragraphs))
              .run()
          }
        >
          Clear formatting
        </button>
        <button
          type="button"
          aria-expanded={editingLink}
          disabled={!active.hasSelection && !active.link}
          onClick={() => {
            setUrl(editor.getAttributes("link").href ?? "");
            setLinkError("");
            setEditingLink(!editingLink);
          }}
        >
          {active.link ? "Edit link" : "Add link"}
        </button>
        {active.link && (
          <button
            type="button"
            onClick={() =>
              editor.chain().focus().extendMarkRange("link").unsetLink().run()
            }
          >
            Remove link
          </button>
        )}
      </div>
      {editingLink && (
        <form
          className="word-controls"
          onSubmit={(event) => {
            event.preventDefault();
            const href = safeWebLink(url);
            if (!href) {
              setLinkError("Enter an http, https, or mailto address.");
              return;
            }
            editor
              .chain()
              .focus()
              .extendMarkRange("link")
              .setLink({ href })
              .run();
            setEditingLink(false);
          }}
        >
          <label htmlFor={`${fields}-url`}>Link address</label>
          <input
            id={`${fields}-url`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit">Apply link</button>
          <button
            type="button"
            onClick={() => {
              setEditingLink(false);
              editor.commands.focus();
            }}
          >
            Cancel
          </button>
          {linkError && <p role="alert">{linkError}</p>}
        </form>
      )}
      <details className="word-more">
        <summary>Paragraph and lists</summary>
        <div className="word-controls">
          {Object.entries(paragraphs).map(([name, { label, options }]) => (
            <label key={name}>
              {label}
              <select
                value={active.blockStyle[name] ?? ""}
                onChange={(event) =>
                  editor
                    .chain()
                    .focus()
                    .updateAttributes("heading", {
                      [name]: event.target.value || null,
                    })
                    .updateAttributes("paragraph", {
                      [name]: event.target.value || null,
                    })
                    .run()
                }
              >
                <option value="">Default</option>
                {Object.entries(options).map(([value, text]) => (
                  <option value={value} key={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            Quote
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            Divider
          </button>
          <button
            type="button"
            onClick={() =>
              editor.chain().focus().sinkListItem("listItem").run()
            }
          >
            Indent list item
          </button>
          <button
            type="button"
            onClick={() =>
              editor.chain().focus().liftListItem("listItem").run()
            }
          >
            Outdent list item
          </button>
        </div>
      </details>
    </div>
  );
}
