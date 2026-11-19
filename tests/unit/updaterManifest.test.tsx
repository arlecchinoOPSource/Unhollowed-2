// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// U2-P7-03: the manifest only ever points at present, version-bound packages
// signed by the expected key. The fixtures are signed with the test-only key
// for version 0.2.0 (other-version.sig: 0.1.5; wrong-key.sig: another key).
const fixture = (name: string) =>
  readFileSync(`src-tauri/fixtures/updater/${name}`, "utf8");
const TEST_KEY = fixture("test-key.pub").trim();
const packages = [
  "Unhollowed 2_0.2.0_aarch64.app.tar.gz",
  "Unhollowed 2_0.2.0_x64-setup.exe",
  "Unhollowed 2_0.2.0_x64_en-US.msi",
];

function release(sig = fixture("good.sig")) {
  const dir = mkdtempSync(join(tmpdir(), "u2-manifest-"));
  for (const name of packages) {
    writeFileSync(join(dir, name), `bytes of ${name}`);
    writeFileSync(join(dir, `${name}.sig`), sig);
  }
  return dir;
}

const manifest = (dir: string, env: Record<string, string> = {}) =>
  spawnSync("node", ["scripts/updater-manifest.mjs", dir, "0.2.0"], {
    encoding: "utf8",
    env: { ...process.env, UPDATER_PUBKEY: TEST_KEY, ...env },
  });

describe("updater-manifest.mjs", () => {
  it("maps every target to its own installer family and signature", () => {
    const result = manifest(release());
    expect(result.status, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.version).toBe("0.2.0");
    expect(json.pub_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const base =
      "https://github.com/arlecchinoOPSource/Unhollowed-2/releases/download/v0.2.0/";
    expect(
      Object.fromEntries(
        Object.entries(json.platforms).map(([target, entry]) => [
          target,
          (entry as { url: string }).url.replace(base, ""),
        ]),
      ),
    ).toEqual({
      "darwin-aarch64": "Unhollowed-2_0.2.0_aarch64.app.tar.gz",
      "darwin-aarch64-app": "Unhollowed-2_0.2.0_aarch64.app.tar.gz",
      "windows-x86_64": "Unhollowed-2_0.2.0_x64-setup.exe",
      "windows-x86_64-nsis": "Unhollowed-2_0.2.0_x64-setup.exe",
      "windows-x86_64-msi": "Unhollowed-2_0.2.0_x64_en-US.msi",
    });
    for (const entry of Object.values(json.platforms))
      expect((entry as { signature: string }).signature).toBe(
        fixture("good.sig").trim(),
      );
  });

  it("refuses a missing package or signature", () => {
    const dir = release();
    rmSync(join(dir, `${packages[2]}.sig`));
    const noSig = manifest(dir);
    expect(noSig.status).not.toBe(0);
    expect(noSig.stdout).toBe("");
    expect(noSig.stderr).toMatch(/Missing updater signature/);
    const noPackage = release();
    rmSync(join(noPackage, packages[0]));
    expect(manifest(noPackage).stderr).toMatch(/Missing updater package/);
  });

  it("refuses a signature bound to another version or made by another key", () => {
    expect(manifest(release(fixture("other-version.sig"))).stderr).toMatch(
      /not bound to version 0\.2\.0/,
    );
    expect(manifest(release(fixture("wrong-key.sig"))).stderr).toMatch(
      /different key/,
    );
  });

  it("checks against the embedded production key by default", () => {
    const env = { ...process.env };
    delete env.UPDATER_PUBKEY;
    const result = spawnSync(
      "node",
      ["scripts/updater-manifest.mjs", release(), "0.2.0"],
      { encoding: "utf8", env },
    );
    expect(result.stderr).toMatch(/different key/);
  });
});
