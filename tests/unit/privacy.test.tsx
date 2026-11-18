// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, found);
    else found.push(path);
  }
  return found;
}
const source = files("src").filter((path) => /\.(tsx?|css)$/.test(path));
const code = (path: string) => readFileSync(path, "utf8");

describe("privacy claims (U2-P6-04)", () => {
  it("has files to scan", () => expect(source.length).toBeGreaterThan(50));

  it("never calls a network API from the frontend", () => {
    const network =
      /\bfetch\(|XMLHttpRequest|new WebSocket|EventSource|sendBeacon|serviceWorker/;
    expect(source.filter((path) => network.test(code(path)))).toEqual([]);
  });

  it("loads no remote script, style, font, or image", () => {
    const remote =
      /(src|href)=["']https?:|url\(\s*["']?https?:|@import\s+["']?https?:/;
    const pages = [...source, "index.html"];
    expect(pages.filter((path) => remote.test(code(path)))).toEqual([]);
  });

  it("writes nothing to the console, so no workspace text can be logged", () => {
    const logging = /console\.(log|info|warn|error|debug|trace)\(/;
    expect(
      source
        .filter((path) => !/\.test\./.test(path))
        .filter((path) => logging.test(code(path))),
    ).toEqual([]);
  });

  it("has no analytics or telemetry package", () => {
    const manifest = code("package.json") + code("src-tauri/Cargo.toml");
    expect(manifest).not.toMatch(
      /sentry|posthog|mixpanel|segment|amplitude|analytics-|telemetry|datadog|bugsnag|reqwest|ureq|hyper/i,
    );
  });
});
