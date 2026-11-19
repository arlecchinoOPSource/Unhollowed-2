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

  describe("with updater packages (U2-P7-03)", () => {
    // Real minisign signatures from the test-only key, bound to 0.2.0 and 0.1.5.
    const fixture = (name: string) =>
      readFileSync(`src-tauri/fixtures/updater/${name}`, "utf8");
    const winUpdate = [
      "Unhollowed 2_0.2.0_x64-setup.exe",
      "Unhollowed 2_0.2.0_x64_en-US.msi",
    ];
    const signed = (names: string[], sig = fixture("good.sig")) => {
      const dir = files(names);
      for (const name of names)
        if (!name.endsWith(".dmg"))
          writeFileSync(join(dir, `${name}.sig`), sig);
      return dir;
    };
    // The fixtures are signed with the test key, not the embedded one.
    const verifyUpdater = (args: string[]) =>
      run("verify-artifacts.sh", args, {
        UPDATER_PUBKEY: fixture("test-key.pub").trim(),
      });

    it("accepts signed Windows installers and lists the signatures in the checksums", () => {
      const dir = signed(winUpdate);
      const result = verifyUpdater(["windows", dir, "0.2.0", "updater"]);
      expect(result.status, result.stderr).toBe(0);
      const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8")
        .trim()
        .split("\n");
      expect(sums).toHaveLength(4);
      expect(readFileSync(join(dir, "BUILD-INFO.txt"), "utf8")).toContain(
        "updater packages: signed, bound to 0.2.0",
      );
    });

    it("requires the macOS updater archive and its signature", () => {
      const names = [
        "Unhollowed 2_0.2.0_aarch64.dmg",
        "Unhollowed 2_0.2.0_aarch64.app.tar.gz",
      ];
      expect(
        verifyUpdater(["macos", signed(names), "0.2.0", "updater"]).status,
      ).toBe(0);
      const missing = verifyUpdater([
        "macos",
        signed([names[0]]),
        "0.2.0",
        "updater",
      ]);
      expect(missing.stderr).toMatch(
        /Missing expected installer: .*app\.tar\.gz/,
      );
    });

    it("fails on a missing signature or one for another version", () => {
      const dir = signed(winUpdate);
      writeFileSync(join(dir, `${winUpdate[1]}.sig`), "");
      expect(
        verifyUpdater(["windows", dir, "0.2.0", "updater"]).stderr,
      ).toMatch(/Missing or empty updater signature/);
      const stale = signed(winUpdate, fixture("other-version.sig"));
      expect(
        verifyUpdater(["windows", stale, "0.2.0", "updater"]).stderr,
      ).toMatch(/not bound to version 0\.2\.0/);
    });

    it("fails on a signature made by a key other than the embedded one", () => {
      // Without UPDATER_PUBKEY the script reads the production key.
      const result = run("verify-artifacts.sh", [
        "windows",
        signed(winUpdate),
        "0.2.0",
        "updater",
      ]);
      expect(result.stderr).toMatch(/different key than the embedded one/);
    });

    it("fails if a private signing key is in the folder, in any mode", () => {
      const dir = files(windows);
      writeFileSync(
        join(dir, "leftover.key"),
        "untrusted comment: rsign encrypted secret key\nnot a real key\n",
      );
      const result = run("verify-artifacts.sh", ["windows", dir, "1.0.0"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/private signing key/);
    });
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
