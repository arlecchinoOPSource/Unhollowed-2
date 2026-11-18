// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// One release version must appear identically everywhere the app, the
// installers, and the lockfiles record it (U2-P6-16, docs/VERSIONING.md).
const read = (path: string) => readFileSync(path, "utf8");
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

function versions() {
  const packageJson = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  const manifest = /^version\s*=\s*"([^"]+)"/m.exec(
    read("src-tauri/Cargo.toml"),
  );
  const cargoLock = /name = "unhollowed-2"\nversion = "([^"]+)"/.exec(
    read("src-tauri/Cargo.lock"),
  );
  return {
    "package.json": packageJson.version,
    "package-lock.json": lock.version,
    "package-lock.json (root package)": lock.packages[""].version,
    "Cargo.toml": manifest?.[1],
    "Cargo.lock": cargoLock?.[1],
    "tauri.conf.json": conf.version,
  };
}

it("records the same SemVer version in every file", () => {
  const found = versions();
  const distinct = new Set(Object.values(found));
  expect(distinct.size, JSON.stringify(found, null, 1)).toBe(1);
  const [version] = [...distinct] as string[];
  expect(version).toMatch(semver);
});

it("names the same application in the manifests", () => {
  expect(JSON.parse(read("package.json")).name).toBe("unhollowed-2");
  expect(read("src-tauri/Cargo.toml")).toMatch(/^name = "unhollowed-2"/m);
});
