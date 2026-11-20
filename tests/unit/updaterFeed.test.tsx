// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions } from "../../scripts/updater-feed.mjs";

// U2-P7-07: the promotion gate. A manifest becomes the feed only if every
// package it names is published, matches SHA256SUMS, and verifies with the
// embedded key for its version, and the version moves forward.
const fixture = (name: string) =>
  readFileSync(`src-tauri/fixtures/updater/${name}`);
const TEST_KEY = fixture("test-key.pub").toString().trim();
const VERSION = "0.2.0";
const base = `https://github.com/arlecchinoOPSource/Unhollowed-2/releases/download/v${VERSION}/`;
const names = {
  mac: `Unhollowed-2_${VERSION}_aarch64.app.tar.gz`,
  nsis: `Unhollowed-2_${VERSION}_x64-setup.exe`,
  msi: `Unhollowed-2_${VERSION}_x64_en-US.msi`,
};

/** A published release folder: the signed fixture bytes under every name. */
function release() {
  const dir = mkdtempSync(join(tmpdir(), "u2-feed-"));
  const package_ = fixture("package.bin");
  const sums = Object.values(names).map((name) => {
    writeFileSync(join(dir, name), package_);
    return `${createHash("sha256").update(package_).digest("hex")}  ${name}`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}, sig = "good.sig") {
  const signature = fixture(sig).toString().trim();
  const entry = (name: string) => ({ url: base + name, signature });
  return {
    version: VERSION,
    notes: "",
    pub_date: "2026-11-20T10:00:00Z",
    platforms: {
      "darwin-aarch64": entry(names.mac),
      "darwin-aarch64-app": entry(names.mac),
      "windows-x86_64": entry(names.nsis),
      "windows-x86_64-nsis": entry(names.nsis),
      "windows-x86_64-msi": entry(names.msi),
    },
    ...overrides,
  };
}

function check(
  feed: unknown,
  { assets = release(), args = [] as string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "u2-feed-json-"));
  const file = join(dir, "latest.json");
  writeFileSync(file, typeof feed === "string" ? feed : JSON.stringify(feed));
  return spawnSync(
    "node",
    ["scripts/updater-feed.mjs", file, "--assets", assets, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, UPDATER_PUBKEY: TEST_KEY },
    },
  );
}

const current = (version: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "u2-live-")), "live.json");
  writeFileSync(file, JSON.stringify({ version }));
  return file;
};

describe("updater-feed.mjs", () => {
  it("accepts a complete, published, correctly signed manifest", () => {
    const result = check(manifest());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Feed OK: 0\.2\.0, 5 targets, 3 packages/);
  });

  it("refuses a missing or changed asset", () => {
    const missing = release();
    rmSync(join(missing, names.msi));
    expect(check(manifest(), { assets: missing }).stderr).toMatch(
      /Release asset not found/,
    );
    const changed = release();
    writeFileSync(join(changed, names.nsis), "a different package");
    expect(check(manifest(), { assets: changed }).stderr).toMatch(
      /does not match SHA256SUMS/,
    );
  });

  it("refuses a package whose digest was updated but whose signature no longer matches", () => {
    const dir = release();
    const other = Buffer.from("a different package");
    writeFileSync(join(dir, names.mac), other);
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").replace(
      new RegExp(`^\\w+  ${names.mac.replaceAll(".", "\\.")}$`, "m"),
      `${createHash("sha256").update(other).digest("hex")}  ${names.mac}`,
    );
    writeFileSync(join(dir, "SHA256SUMS"), sums);
    expect(check(manifest(), { assets: dir }).stderr).toMatch(
      /signature does not match/,
    );
  });

  it("refuses a wrong key or a signature for another version", () => {
    expect(check(manifest({}, "wrong-key.sig")).stderr).toMatch(
      /different key/,
    );
    expect(check(manifest({}, "other-version.sig")).stderr).toMatch(
      /not bound to version 0\.2\.0/,
    );
  });

  it("refuses an incomplete or wrongly mapped manifest", () => {
    const partial = manifest();
    delete (partial.platforms as Record<string, unknown>)["windows-x86_64-msi"];
    expect(check(partial).stderr).toMatch(/must list exactly/);
    const swapped = manifest();
    swapped.platforms["windows-x86_64-msi"] =
      swapped.platforms["windows-x86_64-nsis"];
    expect(check(swapped).stderr).toMatch(/windows-x86_64-msi must point at/);
    const insecure = manifest();
    insecure.platforms["darwin-aarch64"] = {
      ...insecure.platforms["darwin-aarch64"],
      url: insecure.platforms["darwin-aarch64"].url.replace("https:", "http:"),
    };
    expect(check(insecure).stderr).toMatch(/darwin-aarch64 must point at/);
    expect(check("{ not json").stderr).toMatch(/not valid JSON/);
    expect(check(manifest({ version: "next" })).stderr).toMatch(/SemVer/);
  });

  it("refuses a manifest pointing at another release", () => {
    const result = check(manifest(), {
      args: ["--release-tag", "dry-run-v0.2.0"],
    });
    expect(result.stderr).toMatch(/must point at .*dry-run-v0\.2\.0/);
  });

  it("only moves the feed forward, unless withdrawing on purpose", () => {
    expect(
      check(manifest(), { args: ["--current", current("0.1.0")] }).status,
    ).toBe(0);
    expect(
      check(manifest(), { args: ["--current", current("0.2.0")] }).stderr,
    ).toMatch(/not newer than the live feed's 0\.2\.0/);
    expect(
      check(manifest(), { args: ["--current", current("0.3.0")] }).status,
    ).not.toBe(0);
    expect(
      check(manifest(), {
        args: ["--current", current("0.3.0"), "--allow-older"],
      }).status,
    ).toBe(0);
  });

  it("orders versions by SemVer precedence", () => {
    const ordered = [
      "1.0.0-beta.1",
      "1.0.0-beta.2",
      "1.0.0-beta.10",
      "1.0.0-rc.1",
      "1.0.0",
      "1.1.0-beta.1",
      "1.1.0",
    ];
    for (let i = 1; i < ordered.length; i++)
      expect(compareVersions(ordered[i - 1], ordered[i])).toBeLessThan(0);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
  });
});
