// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const csp: string = conf.app.security.csp;

describe("desktop trust boundary (U2-P6-01)", () => {
  it("grants the window no plugin or core permissions", () => {
    const files = readdirSync("src-tauri/capabilities");
    expect(files).toEqual(["main.json"]);
    const capability = JSON.parse(read("src-tauri/capabilities/main.json"));
    expect(capability.permissions).toEqual([]);
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
  });

  it("keeps the production CSP local-only with no inline or eval code", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
  });

  it("does not expose the Tauri global or an asset protocol scope", () => {
    expect(conf.app.withGlobalTauri).toBeUndefined();
    expect(conf.app.security.assetProtocol).toBeUndefined();
  });

  it("registers no shell, fs, http or opener plugin", () => {
    const manifest = read("src-tauri/Cargo.toml");
    expect(manifest).not.toMatch(
      /tauri-plugin-(shell|fs|http|opener|process|updater|global-shortcut)/,
    );
    expect(read("package.json")).not.toMatch(
      /@tauri-apps\/plugin-(shell|fs|http|opener|process|updater)/,
    );
  });
});
