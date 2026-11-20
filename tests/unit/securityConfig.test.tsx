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
      /tauri-plugin-(shell|fs|http|opener|process|global-shortcut)/,
    );
    // The updater runs from Rust only (U2-P7-02); the webview gets no plugin API.
    expect(read("package.json")).not.toMatch(
      /@tauri-apps\/plugin-(shell|fs|http|opener|process|updater)/,
    );
  });

  it("reads updates only from the reviewed HTTPS beta channel (U2-P7-02)", () => {
    const updater = conf.plugins.updater;
    expect(updater.endpoints).toEqual([
      "https://github.com/arlecchinoOPSource/Unhollowed-2/releases/download/updater-beta/latest.json",
    ]);
    expect(updater.pubkey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    for (const key of Object.keys(updater)) {
      expect(key).not.toMatch(/^dangerous|^allowDowngrades$/);
    }
  });

  // Rotating the key is a deliberate, reviewed step: update this ID with it
  // (docs/UPDATER_SIGNING.md). The test fixtures' key must never ship.
  it("embeds the owner's updater key and requires signed versions (U2-P7-03)", () => {
    const updater = conf.plugins.updater;
    const key = Buffer.from(updater.pubkey, "base64").toString("utf8");
    expect(key).toContain("minisign public key: 391B93A7FCFD9454");
    expect(updater.pubkey).not.toBe(
      read("src-tauri/fixtures/updater/test-key.pub").trim(),
    );
    expect(updater.requireSignedVersion).toBe(true);
  });
});

it("isolates the native acceptance client without relaxing package trust", () => {
  const acceptance = JSON.parse(
    read("src-tauri/tauri.updater-acceptance.conf.json"),
  );
  expect(acceptance).toEqual({
    $schema: conf.$schema,
    version: "1.1.0-beta.0",
    bundle: { windows: { wix: { version: "1.0.60000" } } },
    plugins: {
      updater: {
        endpoints: [
          "https://github.com/arlecchinoOPSource/Unhollowed-2/releases/download/updater-dry-run/latest.json",
        ],
      },
    },
  });
  expect(read(".github/workflows/platform-build.yml")).not.toContain(
    "tauri.updater-acceptance.conf.json",
  );
});
