// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The release checks of U2-P6-19 (docs/RELEASE.md), run against fixtures.
const run = (
  script: string,
  args: string[],
  env: Record<string, string> = {},
) =>
  spawnSync("bash", [join(process.cwd(), "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

function repo(version: string, conf = version) {
  const root = mkdtempSync(join(tmpdir(), "u2-release-"));
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({ version: conf }),
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "first",
  );
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

describe("verify-release-tag.sh", () => {
  it("accepts a tag that matches every version and sits on main", () => {
    const root = repo("1.0.0-beta.1");
    const result = run("verify-release-tag.sh", ["v1.0.0-beta.1"], {
      REPO_ROOT: root,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["1.0.0", "v1.0", "v1.0.0-", "release-1"])(
    "rejects the malformed tag %s",
    (tag) => {
      const result = run("verify-release-tag.sh", [tag], {
        REPO_ROOT: repo("1.0.0"),
      });
      expect(result.status).not.toBe(0);
    },
  );

  it("rejects a tag that differs from the app version", () => {
    const result = run("verify-release-tag.sh", ["v1.0.1"], {
      REPO_ROOT: repo("1.0.0"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/says version 1\.0\.0/);
  });

  it("rejects a tag when the manifests disagree", () => {
    const result = run("verify-release-tag.sh", ["v1.0.0"], {
      REPO_ROOT: repo("1.0.0", "0.9.0"),
    });
    expect(result.status).not.toBe(0);
  });

  it("rejects a commit that is not on main", () => {
    const root = repo("1.0.0");
    writeFileSync(join(root, "extra.txt"), "x");
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "add",
      "-A",
    );
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "unreviewed",
    );
    const result = run("verify-release-tag.sh", ["v1.0.0"], {
      REPO_ROOT: root,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not on main/);
  });
});

describe("verify-artifacts.sh", () => {
  const files = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "u2-artifacts-"));
    for (const name of names)
      writeFileSync(join(dir, name), `bytes of ${name}`);
    return dir;
  };
  const windows = [
    "Unhollowed 2_1.0.0_x64-setup.exe",
    "Unhollowed 2_1.0.0_x64_en-US.msi",
  ];

  it("accepts both Windows installers and writes checksums and a manifest", () => {
    const dir = files(windows);
    const result = run("verify-artifacts.sh", ["windows", dir, "1.0.0"], {
      GITHUB_SHA: "abc123",
      GITHUB_RUN_ID: "9",
    });
    expect(result.status, result.stderr).toBe(0);
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n");
    expect(sums).toHaveLength(2);
    expect(sums[0]).toMatch(
      /^[0-9a-f]{64}\s+\*?Unhollowed 2_1\.0\.0_x64-setup\.exe$/,
    );
    const info = readFileSync(join(dir, "BUILD-INFO.txt"), "utf8");
    expect(info).toContain("commit: abc123");
    expect(info).toContain("version: 1.0.0");
  });

  it("fails when the MSI is missing even though the setup exists", () => {
    const result = run("verify-artifacts.sh", [
      "windows",
      files([windows[0]]),
      "1.0.0",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Missing expected installer/);
  });

  it("fails on a wrong architecture label or a stale extra installer", () => {
    expect(
      run("verify-artifacts.sh", [
        "windows",
        files(["Unhollowed 2_1.0.0_x86-setup.exe", windows[1]]),
        "1.0.0",
      ]).status,
    ).not.toBe(0);
    const stale = run("verify-artifacts.sh", [
      "windows",
      files([...windows, "Unhollowed 2_0.9.0_x64-setup.exe"]),
      "1.0.0",
    ]);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toMatch(/Unexpected installer/);
  });

  it("fails on an empty installer and writes nothing", () => {
    const dir = files(windows);
    writeFileSync(join(dir, windows[0]), "");
    expect(
      run("verify-artifacts.sh", ["windows", dir, "1.0.0"]).status,
    ).not.toBe(0);
    expect(existsSync(join(dir, "SHA256SUMS"))).toBe(false);
  });

  it("requires an Apple Silicon DMG on macOS", () => {
    expect(
      run("verify-artifacts.sh", [
        "macos",
        files(["Unhollowed 2_1.0.0_aarch64.dmg"]),
        "1.0.0",
      ]).status,
    ).toBe(0);
    expect(
      run("verify-artifacts.sh", [
        "macos",
        files(["Unhollowed 2_1.0.0_x64.dmg"]),
        "1.0.0",
      ]).status,
    ).not.toBe(0);
  });
});
