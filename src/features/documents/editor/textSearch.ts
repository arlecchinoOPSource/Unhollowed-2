import type { Node } from "@tiptap/pm/model";

export interface Match {
  from: number;
  to: number;
}

/** Match literal text inside a block, even across differently formatted runs. */
export function findText(document: Node, query: string): Match[] {
  if (!query) return [];
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const matches: Match[] = [];
  document.descendants((block, blockPosition) => {
    if (!block.isTextblock) return;
    let text = "";
    let start = 0;
    function collect() {
      for (const match of text.matchAll(pattern)) {
        const from = blockPosition + 1 + start + match.index;
        matches.push({ from, to: from + match[0].length });
      }
      text = "";
    }
    block.forEach((child, offset) => {
      if (!child.isText) {
        collect();
      } else {
        if (!text) start = offset;
        text += child.text ?? "";
      }
    });
    collect();
    return false;
  });
  return matches;
}
