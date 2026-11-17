# Document editor

The document editor uses a document-specific Tiptap schema. The issue editor retains its existing extension list. A document without a root `schemaVersion` is treated as version 1. New writes include the version. Unknown versions or unsupported node structures open with an error and leave the saved content in place.

Fonts are curated system choices with fallbacks. Style keys are serialized in document JSON and rendered with local CSS classes in both themes. Hyperlinks support HTTP, HTTPS, and mailto. The editor parses clipboard content through the ProseMirror schema. Paste retains supported markup and treats styles outside the supported choices as plain formatting.

Document autosave is debounced by 700 ms. Writes for an ID run in order across editor navigation. A local draft journal lets the user resume interrupted edits or keep the database copy. If the WebView's storage quota is exceeded, the editor warns and continues to save through SQLite. Recovery is intended for the same app profile and does not sync drafts between installs.

SQLite checkpoints the displaced content up to once every five minutes per document. An explicit restore always checkpoints the displaced version in the same transaction. The latest 20 checkpoints per document are kept. The revision picker is disabled until current edits are saved or discarded.

Find matches literal text without regard to case inside a block, including across adjacent formatting runs. Replace all is one undoable change. The heading outline navigates to headings, and Focus Mode centers the writing area. Escape or the visible exit control restores the normal layout.

## File transfer

Import UTF-8 Markdown and plain text from the library to create a new
document. Markdown keeps common headings, lists, tables, links, and emphasis.
Embedded HTML is treated as text and image links become alternative text.
The import limit is 512 KiB.

Export Markdown, text, or basic HTML from the editor. HTML embeds managed
images locally and includes supported editor styles and print settings.
Workspace links appear as their visible labels in portable documents.
Markdown and plain text omit page layout, images, and custom typography.
Use Print to save a PDF with the platform print dialog.
