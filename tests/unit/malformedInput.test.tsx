import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readWritingFile } from "../../src/features/documents/editor/fileTransfer";
import { importWordFile } from "../../src/features/documents/editor/importWord";
import { safeWebLink } from "../../src/features/documents/editor/schema";

const mib = 1024 * 1024;
const word = (name: string, parts: Record<string, Uint8Array>) =>
  new File([zipSync(parts) as BlobPart], name);

describe("links (U2-P6-03)", () => {
  it.each([
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "//evil.example",
    "not a url",
    "",
  ])("rejects %j", (value) => expect(safeWebLink(value)).toBeNull());

  it("keeps http, https, and mailto", () => {
    expect(safeWebLink("https://example.com/a")).toBe("https://example.com/a");
    expect(safeWebLink("mailto:a@example.com")).toBe("mailto:a@example.com");
  });
});

describe("Word import limits (U2-P6-03)", () => {
  it("refuses a file over 16 MiB before reading it", async () => {
    const file = new File(["x"], "big.docx");
    Object.defineProperty(file, "size", { value: 16 * mib + 1 });
    await expect(importWordFile(file)).rejects.toThrow(/under 16 MiB/);
  });

  it("refuses bytes that are not a zip archive", async () => {
    const file = new File([strToU8("this is not a zip")], "bad.docx");
    await expect(importWordFile(file)).rejects.toThrow();
  });

  it("refuses an archive with no Word document", async () => {
    const file = word("empty.docx", { "readme.txt": strToU8("hello") });
    await expect(importWordFile(file)).rejects.toThrow(
      /does not contain a Word document/,
    );
  });

  it("refuses a small archive that expands past the per-entry limit", async () => {
    const file = word("bomb.docx", {
      "word/document.xml": new Uint8Array(9 * mib),
      "[Content_Types].xml": strToU8("<Types/>"),
    });
    expect(file.size).toBeLessThan(mib);
    await expect(importWordFile(file)).rejects.toThrow(/archive limits/);
  });

  it("refuses an archive with too many entries", async () => {
    const parts: Record<string, Uint8Array> = {
      "[Content_Types].xml": strToU8("<Types/>"),
    };
    for (let index = 0; index < 520; index++)
      parts[`word/part${index}.xml`] = strToU8("<a/>");
    await expect(importWordFile(word("many.docx", parts))).rejects.toThrow(
      /archive limits/,
    );
  });
});

describe("text and Markdown import (U2-P6-03)", () => {
  it("refuses unknown extensions, oversized files, and invalid UTF-8", async () => {
    await expect(readWritingFile(new File(["x"], "run.exe"))).rejects.toThrow(
      /Choose an Unhollowed/,
    );
    await expect(
      readWritingFile(new File([new Uint8Array(512 * 1024 + 1)], "a.md")),
    ).rejects.toThrow(/under 512 KiB/);
    await expect(
      readWritingFile(new File([new Uint8Array([0xff, 0xfe, 0xfd])], "a.txt")),
    ).rejects.toThrow();
  });

  it("never turns raw HTML or script links in Markdown into live markup", async () => {
    const text =
      "<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://example.com)";
    const { content } = await readWritingFile(new File([text], "evil.md"));
    const json = JSON.stringify(content);
    expect(json).not.toMatch(/"href":"javascript:/);
    expect(json).toContain("https://example.com");
    expect(json).not.toMatch(/"type":"(script|image)"/);
    expect(json).not.toMatch(
      /"marks":\[\{"type":"link","attrs":\{"href":"(?!https:\/\/example)/,
    );
  });
});
