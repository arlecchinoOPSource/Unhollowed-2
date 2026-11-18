# Document editor

The document editor uses a document-specific Tiptap schema. The issue editor retains its existing extension list. A document without a root `schemaVersion` is treated as version 1. New writes include the version. Unknown versions or unsupported node structures open with an error and leave the saved content in place.

Fonts are curated system choices with fallbacks. Style keys are serialized in document JSON and rendered with local CSS classes in both themes. Hyperlinks support HTTP, HTTPS, and mailto. The editor parses clipboard content through the ProseMirror schema. Paste retains supported markup and treats styles outside the supported choices as plain formatting.

Document autosave is debounced by 700 ms. Writes for an ID run in order across editor navigation. A local draft journal lets the user resume interrupted edits or keep the database copy. If the WebView's storage quota is exceeded, the editor warns and continues to save through SQLite. Recovery is intended for the same app profile and does not sync drafts between installs.

SQLite checkpoints the displaced content up to once every five minutes per document. An explicit restore always checkpoints the displaced version in the same transaction. The latest 20 checkpoints per document are kept. The revision picker is disabled until current edits are saved or discarded.

Command+F on macOS or Ctrl+F opens Find & Replace, including in Focus Mode. Typing `[[` opens document suggestions. Use the down arrow to enter the suggestions, Enter to insert a link, or Escape to dismiss them. Workspace search indexes the titles and contents of active documents and opens matches directly.

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
Use Print to save a PDF with the platform print dialog. On macOS the
native dialog receives the selected paper size, orientation, and margins.
The current WKWebView print path can omit explicit page breaks and CSS
page headers, footers, and numbers. Check the print preview when those
details matter. Chromium's PDF check covers explicit breaks and paper
geometry.

### Microsoft Word

Import and export DOCX entirely offline. Word import supports headings,
lists, common emphasis, basic tables, links, and embedded PNG, JPEG, GIF
and WebP images. It imports supported paper size, orientation, and a single
uniform margin. Image bytes and the imported document are saved together.

Word export writes editable paragraphs, headings, lists, tables, links and
images, plus supported typography and page settings. Images are sized to
the available page. WebP is converted to PNG in the export. The Word
converter can omit authoring details such as arbitrary Word styles,
different margins per edge, multiple sections, and review markup. Review
layout and formatting in Word before sharing the result.

### Native document files

Export an Unhollowed file (.u2doc) to keep the document body, supported
formatting, layout, and referenced images together. Import creates a
separate document in the active workspace and assigns its images new
local IDs. Internal links keep their document IDs and resolve when those
targets exist in the active workspace. A document file travels independently
of folder placement, project associations, and version history.

## Compatibility fixture matrix (U2-P6-10)

Commit `e76fc3a` plus this change, Chromium on macOS arm64. Rows marked "Fixture" run the app's own export and import code on the matrix in `tests/browser/documentFixtures.spec.ts`. Rows marked "Existing" are covered by `tests/browser/documents.spec.ts`. Word is not required to match one for one.

| Area                                                        | In the app                                                                                                | Word export (what Word receives)                          | Word import (what comes back)                                          | Evidence                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Headings 1 to 3                                             | Yes                                                                                                       | Word heading styles                                       | Kept                                                                   | Fixture                                                                                             |
| Bold, italic, underline, strike                             | Yes                                                                                                       | Kept                                                      | Kept                                                                   | Fixture                                                                                             |
| Links                                                       | http, https, mailto only                                                                                  | Hyperlinks                                                | Kept. Word styles them underlined, so the link also gains an underline | Fixture                                                                                             |
| Bulleted, numbered, nested lists                            | Yes                                                                                                       | Kept                                                      | Kept, including nesting                                                | Fixture                                                                                             |
| Tables with header cells                                    | Yes                                                                                                       | Kept                                                      | Kept                                                                   | Fixture, Existing                                                                                   |
| Block quote                                                 | Yes                                                                                                       | Written as a paragraph                                    | Comes back as a normal paragraph; the text is kept                     | Fixture                                                                                             |
| Paragraph alignment, line spacing, spacing before and after | Yes                                                                                                       | Written (center, justify, double spacing seen in the XML) | **Lost**: reads back as default                                        | Fixture                                                                                             |
| Fonts and sizes                                             | 7 curated fonts, 14 sizes                                                                                 | Written (Georgia, 18 pt seen in the XML)                  | **Lost**: reads back as the default font and size                      | Fixture                                                                                             |
| Page size, orientation, margin                              | A4, Letter, Legal; portrait or landscape                                                                  | Written                                                   | Kept                                                                   | Fixture                                                                                             |
| Page break                                                  | Yes                                                                                                       | Written as a page break                                   | **Lost**: reads back as an empty paragraph                             | Fixture                                                                                             |
| Images                                                      | PNG, JPEG, GIF, WebP, 8 MiB each                                                                          | Embedded                                                  | Kept (limits in [Security](SECURITY.md))                               | Existing                                                                                            |
| Markdown import and export                                  | Headings, emphasis, links, tables; images become alt text                                                 | n/a                                                       | n/a                                                                    | Existing                                                                                            |
| Text and HTML export                                        | Yes                                                                                                       | n/a                                                       | n/a                                                                    | Existing                                                                                            |
| Native `.u2doc` round trip                                  | Fonts and unknown versions                                                                                | n/a                                                       | n/a                                                                    | Existing                                                                                            |
| PDF                                                         | Through the operating system's print dialog (Save as PDF); paper size and page breaks follow the document | n/a                                                       | n/a                                                                    | Existing (print geometry and dialog calls, mocked). The PDF file itself was not opened or compared. |
| Internal links and backlinks                                | Document references; references list per document                                                         | n/a                                                       | n/a                                                                    | Existing                                                                                            |
| Knowledge graph                                             | Local and global (500 notes)                                                                              | n/a                                                       | n/a                                                                    | Existing                                                                                            |

### Findings

| ID    | Severity | Finding                                                                                                                                                                                                                                                                        | Status                                                                                                                                                                                             |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOC-1 | Medium   | Importing a `.docx` drops paragraph alignment, spacing, fonts, sizes, and page breaks, so a Word file that is centered or set in Georgia opens plain. Text, structure, tables, links, images, and page layout survive. The converter (mammoth) does not read these properties. | Open. Not fixed here (new import feature). Decide whether to ship as a known limitation in the release notes or schedule a fix. The fixture test fails when this changes, so the doc stays honest. |
| DOC-2 | Low      | Block quotes become plain paragraphs through Word.                                                                                                                                                                                                                             | Accepted for the beta.                                                                                                                                                                             |
| DOC-3 | Info     | A Word export opened in Word, Pages, or LibreOffice was not inspected visually. Fidelity was checked in the generated XML.                                                                                                                                                     | Open: spot-check on a machine with Word (owner).                                                                                                                                                   |

Not run: Windows; real Word, Pages, or LibreOffice; comparing a produced PDF; documents over a few hundred pages.
