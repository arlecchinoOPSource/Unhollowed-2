import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEditorState, type Editor } from "@tiptap/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  dimensions,
  pageCss,
  paperSizes,
  readLayout,
  type Layout,
} from "./pageLayout";
import "./print.css";

const PageMode = createContext(false);
export const DocumentPageMode = PageMode.Provider;

export function useLayout(editor: Editor) {
  const attributes = useEditorState({
    editor,
    selector: ({ editor }) => editor.state.doc.attrs.pageLayout,
  });
  return readLayout(attributes);
}

export function DocumentLayout({
  editor,
  setPageMode,
}: {
  editor: Editor;
  setPageMode: (page: boolean) => void;
}) {
  const layout = useLayout(editor);
  const pageMode = useContext(PageMode);
  const [margin, setMargin] = useState(String(layout.margin));
  const [printError, setPrintError] = useState("");
  const sheet = pageCss(layout);
  const applied = useRef(false);
  // Set while a print request is in flight, so a second click cannot open a
  // second native print operation before the first dialog appears.
  const printing = useRef(false);

  useEffect(() => {
    try {
      const rules = new CSSStyleSheet();
      rules.replaceSync(sheet);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, rules];
      applied.current = true;
      return () => {
        applied.current = false;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (item) => item !== rules,
        );
      };
    } catch {
      applied.current = false;
    }
  }, [sheet]);

  async function print() {
    if (printing.current) return;
    if (!applied.current) {
      setPrintError(
        "This webview could not apply the printable page settings.",
      );
      return;
    }
    setPrintError("");
    printing.current = true;
    try {
      const native =
        isTauri() &&
        (await invoke<boolean>("print_document", {
          settings: {
            paper: layout.paper,
            landscape: layout.landscape,
            margin: layout.margin,
          },
        }));
      if (!native) window.print();
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      setPrintError(
        code === "invalid_print_settings"
          ? "These page settings cannot be printed. Check the margins."
          : "Could not open the print dialog. Try again.",
      );
    } finally {
      printing.current = false;
    }
  }

  function change<K extends keyof Layout>(key: K, value: Layout[K]) {
    const updated = {
      ...readLayout(editor.state.doc.attrs.pageLayout),
      [key]: value,
    };
    editor
      .chain()
      .command(({ tr }) => {
        tr.setDocAttribute("pageLayout", updated);
        return true;
      })
      .run();
  }

  return (
    <details className="word-more document-layout">
      <summary>Page setup and print</summary>
      <div className="word-controls">
        <label>
          Paper
          <select
            value={layout.paper}
            onChange={(event) =>
              change("paper", event.target.value as Layout["paper"])
            }
          >
            {Object.entries(paperSizes).map(([id, { label }]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Orientation
          <select
            value={layout.landscape ? "landscape" : "portrait"}
            onChange={(event) =>
              change("landscape", event.target.value === "landscape")
            }
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
        <label>
          Margins (mm)
          <input
            type="number"
            step="0.1"
            min={10}
            max={50}
            value={margin}
            onChange={(event) => setMargin(event.target.value)}
            onBlur={() => {
              const value = Number(margin);
              const valid =
                Number.isFinite(value) && value >= 10 && value <= 50;
              if (valid) change("margin", value);
              else setMargin(String(layout.margin));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          Page header
          <input
            value={layout.header}
            maxLength={120}
            onChange={(event) => change("header", event.target.value)}
          />
        </label>
        <label>
          Page footer
          <input
            value={layout.footer}
            maxLength={120}
            onChange={(event) => change("footer", event.target.value)}
          />
        </label>
        <label>
          Page numbers
          <input
            type="checkbox"
            checked={layout.numbers}
            onChange={(event) => change("numbers", event.target.checked)}
          />
        </label>
        <button
          type="button"
          aria-pressed={pageMode}
          onClick={() => setPageMode(!pageMode)}
        >
          {pageMode ? "Continuous mode" : "Page mode"}
        </button>
        <button
          type="button"
          onClick={() =>
            editor.chain().focus().insertContent({ type: "pageBreak" }).run()
          }
        >
          Insert page break
        </button>
        <button type="button" onClick={() => void print()}>
          Print / Save as PDF
        </button>
      </div>
      {printError && <p role="alert">{printError}</p>}
      {pageMode && (
        <p>
          The writing view approximates the paper width. Use the system print
          preview for final page breaks.
        </p>
      )}
    </details>
  );
}

export function PageSurface({
  editor,
  children,
}: {
  editor: Editor;
  children: React.ReactNode;
}) {
  const pageMode = useContext(PageMode);
  const layout = useLayout(editor);
  const [width, height] = dimensions(layout);
  return (
    <div
      className="document-page-surface"
      data-page-view={pageMode}
      style={
        {
          "--page-width": `${width}mm`,
          "--page-height": `${height}mm`,
          "--page-margin": `${layout.margin}mm`,
        } as React.CSSProperties
      }
    >
      {pageMode && layout.header && (
        <p className="document-page-note">{layout.header}</p>
      )}
      {children}
      {pageMode && layout.footer && (
        <p className="document-page-note">{layout.footer}</p>
      )}
    </div>
  );
}
