import { invoke } from "@tauri-apps/api/core";
import {
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { useEffect, useState } from "react";

const nodeName = "localImage";
const maxBytes = 8 * 1024 * 1024;
const allowedMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function insertLocalImage(
  editor: Editor,
  documentId: string,
  file: File,
) {
  if (file.size > maxBytes || file.size === 0)
    throw new Error("Choose an image smaller than 8 MiB.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const encoded = String(reader.result).split(",")[1];
      if (encoded) resolve(encoded);
      else reject(new Error("Could not read this image."));
    };
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.readAsDataURL(file);
  });
  const assetId = await invoke<string>("store_document_image", {
    documentId,
    data,
  });
  if (editor.isDestroyed) return;
  editor
    .chain()
    .focus()
    .insertContent({
      type: nodeName,
      attrs: { assetId, alt: file.name.replace(/\.[^.]+$/, "").slice(0, 200) },
    })
    .run();
}

function LocalImage({
  node,
  extension,
  updateAttributes,
  deleteNode,
  editor,
}: NodeViewProps) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const id = node.attrs.assetId as string;
  const documentId = extension.options.documentId as string;
  const width = ["small", "medium", "full"].includes(node.attrs.width)
    ? node.attrs.width
    : "full";
  const alignment = ["left", "center", "right"].includes(node.attrs.alignment)
    ? node.attrs.alignment
    : "center";

  useEffect(() => {
    let current = true;
    invoke<{ mime: string; data: string }>("get_document_image", {
      documentId,
      id,
    }).then(
      ({ mime, data }) => {
        if (!current) return;
        if (allowedMimes.has(mime)) setSource(`data:${mime};base64,${data}`);
        else setFailed(true);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [id, documentId]);

  return (
    <NodeViewWrapper
      className={`word-image word-image-${alignment}`}
      contentEditable={false}
    >
      <figure className={`word-image-${width}`}>
        {source && !failed && (
          <img
            src={source}
            alt={node.attrs.alt ?? ""}
            onError={() => setFailed(true)}
          />
        )}
        {failed && <p role="status">Image unavailable.</p>}
        {!source && !failed && <p>Loading image…</p>}
        {node.attrs.caption && <figcaption>{node.attrs.caption}</figcaption>}
      </figure>
      {editor.isEditable && (
        <details className="word-more">
          <summary>Image options</summary>
          <div className="word-controls">
            <label>
              Image width
              <select
                value={width}
                onChange={(event) =>
                  updateAttributes({ width: event.target.value })
                }
              >
                <option value="small">25%</option>
                <option value="medium">50%</option>
                <option value="full">100%</option>
              </select>
            </label>
            <label>
              Image alignment
              <select
                value={alignment}
                onChange={(event) =>
                  updateAttributes({ alignment: event.target.value })
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label>
              Alternative text
              <input
                value={node.attrs.alt ?? ""}
                maxLength={200}
                onChange={(event) =>
                  updateAttributes({ alt: event.target.value })
                }
              />
            </label>
            <label>
              Caption
              <input
                value={node.attrs.caption ?? ""}
                maxLength={300}
                onChange={(event) =>
                  updateAttributes({ caption: event.target.value })
                }
              />
            </label>
            <button type="button" onClick={deleteNode}>
              Remove image
            </button>
          </div>
        </details>
      )}
    </NodeViewWrapper>
  );
}

export const DocumentImage = Node.create<{
  documentId?: string;
  onImageError?: () => void;
}>({
  name: nodeName,
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({}),
  addAttributes: () => ({
    assetId: { default: null },
    caption: { default: "" },
    alt: { default: "" },
    width: { default: "full" },
    alignment: { default: "center" },
  }),
  // Internal clipboard copy preserves the asset reference. HTML imports do
  // not load arbitrary network or file paths.
  parseHTML: () => [{ tag: "figure[data-u2-image]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "figure",
    { ...HTMLAttributes, "data-u2-image": "" },
    ["figcaption", {}, HTMLAttributes.caption || HTMLAttributes.alt || "Image"],
  ],
  addNodeView: () => ReactNodeViewRenderer(LocalImage),
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { documentId, onImageError } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const file = Array.from(event.clipboardData?.files ?? []).find(
              (candidate) => allowedMimes.has(candidate.type),
            );
            if (!file || !documentId || !editor.isEditable) return false;
            void insertLocalImage(editor, documentId, file).catch(
              onImageError ?? (() => undefined),
            );
            return true;
          },
        },
      }),
    ];
  },
});
