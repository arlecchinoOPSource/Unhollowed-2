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

// Tauri derives the MSI upgrade code from the product name, so a rename would
// make the next MSI install beside the old one. See docs/UPDATER_COMPATIBILITY.md.
it("keeps the product name that sets the MSI upgrade code (U2-P7-01)", () => {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  expect(conf.productName).toBe("Unhollowed 2");
  expect(
    conf.bundle.windows.wix.upgradeCode ??
      "8a580644-dadf-5b7b-853d-70d74a87a67e",
  ).toBe("8a580644-dadf-5b7b-853d-70d74a87a67e");
});
