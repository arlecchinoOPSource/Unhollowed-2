// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, it } from "vitest";

// Every relative link in the README and docs must point at a real file
// (U2-P6-21): users follow these from the install and recovery instructions.
function markdown(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdown(path, found);
    else if (path.endsWith(".md")) found.push(path);
  }
  return found;
}

it("has no broken relative links in the README or docs", () => {
  const broken: string[] = [];
  for (const file of ["README.md", ...markdown("docs")]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (!existsSync(normalize(join(dirname(file), target))))
        broken.push(`${file}: ${target}`);
    }
  }
  expect(broken).toEqual([]);
});
