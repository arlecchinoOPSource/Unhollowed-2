// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The identifier names the app data folder, the webview storage, the macOS
// bundle, and the Windows installer identity. Changing it makes an installed
// app look empty. Change it only through the plan in docs/IDENTITY.md.
it("keeps the permanent application identifier (U2-P6-08)", () => {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  expect(conf.identifier).toBe("dev.arlecchino.unhollowed2");
  expect(conf.identifier).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
  expect(conf.identifier.endsWith(".app")).toBe(false);
  expect(conf.plugins.sql.preload).toEqual(["sqlite:workspace.sqlite3"]);
});
