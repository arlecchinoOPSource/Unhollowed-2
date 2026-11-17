import {
  useEditor,
  useEditorState,
  type Editor,
  type UseEditorOptions,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Italic, List, ListOrdered } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const sharedExtensions = [StarterKit];

/**
 * A Tiptap editor for a rich-text field stored as Tiptap JSON. `onChange`
 * receives the serialized JSON after each edit.
 *
 * The options are created once. Tiptap compares options by reference on each
 * render, so new objects would reapply them to the editor on every render.
 */
export function useRichTextEditor(
  label: string,
  content: string,
  onChange: (content: string) => void,
  extensions: UseEditorOptions["extensions"] = sharedExtensions,
): Editor | null {
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });
  const [options] = useState<UseEditorOptions>(() => ({
    extensions,
    content: JSON.parse(content),
    // Tiptap's injected <style> tag would be blocked by the app's CSP. The
    // equivalent rules live in workspace.css.
    injectCSS: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
      },
    },
    onUpdate: ({ editor }) => change.current(JSON.stringify(editor.getJSON())),
  }));
  return useEditor(options);
}

export function FormattingToolbar({ editor }: { editor: Editor | null }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      heading: current?.isActive("heading", { level: 2 }) ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
    }),
  });

  const tools = [
    {
      label: "Bold",
      icon: Bold,
      pressed: active?.bold,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      icon: Italic,
      pressed: active?.italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "Heading",
      icon: Heading2,
      pressed: active?.heading,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Bulleted list",
      icon: List,
      pressed: active?.bulletList,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      pressed: active?.orderedList,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
  ];

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {tools.map(({ label, icon: Icon, pressed, run }) => (
        <button
          type="button"
          key={label}
          aria-label={label}
          title={label}
          aria-pressed={pressed}
          onClick={run}
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
