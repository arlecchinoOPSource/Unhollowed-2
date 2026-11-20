// Checks an updater manifest before it may become the feed (U2-P7-07).
//
//   node scripts/updater-feed.mjs <manifest.json> [--current <feed.json>]
//        [--release-tag <tag>] [--assets <folder>] [--allow-older]
//
// It downloads every package the manifest names from its public URL (or reads
// it from --assets, for tests), checks the digest against the release's
// SHA256SUMS, and verifies the signature with the embedded key for the
// manifest's version. The version must be newer than --current, the live
// feed, unless --allow-older (a withdrawal to an earlier good release).
// Any problem fails the check and nothing should be published.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  decode,
  embeddedPubkey,
  keyId,
  signedVersion,
  verifies,
} from "./minisign.mjs";

const repository =
  process.env.GITHUB_REPOSITORY ?? "arlecchinoOPSource/Unhollowed-2";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** SemVer 2.0 precedence: negative, zero, or positive, like a comparator. */
export function compareVersions(a, b) {
  const [, ...x] = SEMVER.exec(a);
  const [, ...y] = SEMVER.exec(b);
  for (let i = 0; i < 3; i++)
    if (x[i] !== y[i]) return Number(x[i]) - Number(y[i]);
  if (!x[3] || !y[3]) return x[3] ? -1 : y[3] ? 1 : 0;
  const p = x[3].split(".");
  const q = y[3].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n) return Number(p[i]) - Number(q[i]);
    if (m !== n) return m ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      current: { type: "string" },
      "release-tag": { type: "string" },
      assets: { type: "string" },
      "allow-older": { type: "boolean", default: false },
    },
  });
  const [file] = positionals;
  if (!file) fail("usage: updater-feed.mjs <manifest.json> [options]");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  const { version, platforms } = manifest;
  if (typeof version !== "string" || !SEMVER.test(version))
    fail("The manifest has no valid SemVer version.");
  if (Number.isNaN(Date.parse(manifest.pub_date ?? "")))
    fail("The manifest has no valid pub_date.");
  if (typeof manifest.notes !== "string") fail("The manifest has no notes.");

  // Every published target, each pointing at its own installer family.
  const expected = {
    "darwin-aarch64": `Unhollowed-2_${version}_aarch64.app.tar.gz`,
    "darwin-aarch64-app": `Unhollowed-2_${version}_aarch64.app.tar.gz`,
    "windows-x86_64": `Unhollowed-2_${version}_x64-setup.exe`,
    "windows-x86_64-nsis": `Unhollowed-2_${version}_x64-setup.exe`,
    "windows-x86_64-msi": `Unhollowed-2_${version}_x64_en-US.msi`,
  };
  const targets = Object.keys(platforms ?? {}).sort();
  if (targets.join() !== Object.keys(expected).sort().join())
    fail(
      `The manifest must list exactly: ${Object.keys(expected).join(", ")}.`,
    );

  const tag = values["release-tag"] ?? `v${version}`;
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const pubkey = embeddedPubkey();
  const key = keyId(decode(pubkey));

  const download = async (name) => {
    if (values.assets) {
      const path = join(values.assets, name);
      if (!existsSync(path)) fail(`Release asset not found: ${name}`);
      return readFileSync(path);
    }
    const response = await fetch(base + encodeURIComponent(name));
    if (!response.ok)
      fail(
        `${base}${name} is not publicly available (HTTP ${response.status}).`,
      );
    return Buffer.from(await response.arrayBuffer());
  };

  const sums = new Map(
    (await download("SHA256SUMS"))
      .toString("utf8")
      .split("\n")
      .map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim()))
      .filter(Boolean)
      .map(([, digest, name]) => [name.replaceAll(" ", "-"), digest]),
  );

  const checked = new Map();
  for (const [target, entry] of Object.entries(platforms)) {
    const name = expected[target];
    if (entry?.url !== base + encodeURIComponent(name))
      fail(`${target} must point at ${base}${name}, not ${entry?.url}.`);
    const text = decode(entry.signature ?? "");
    if (signedVersion(text) !== version)
      fail(`${target}: the signature is not bound to version ${version}.`);
    if (keyId(text) !== key)
      fail(`${target}: the signature was made by a different key.`);
    if (!checked.has(name)) {
      const data = await download(name);
      const digest = createHash("sha256").update(data).digest("hex");
      if (sums.get(name) !== digest)
        fail(`${name}: SHA-256 ${digest} does not match SHA256SUMS.`);
      checked.set(name, data);
    }
    if (!verifies(checked.get(name), entry.signature, pubkey))
      fail(`${target}: the signature does not match ${name}.`);
  }

  if (values.current && existsSync(values.current)) {
    const live = JSON.parse(readFileSync(values.current, "utf8")).version;
    if (!values["allow-older"] && compareVersions(version, live) <= 0)
      fail(`${version} is not newer than the live feed's ${live}.`);
  }

  console.log(
    `Feed OK: ${version}, ${targets.length} targets, ${checked.size} packages verified from ${tag}.`,
  );
}

// Runs as a script; tests import compareVersions without running it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
