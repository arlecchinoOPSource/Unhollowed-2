// Writes the updater manifest (latest.json) for one release from its verified
// artifacts (U2-P7-03). See docs/UPDATER_SIGNING.md.
//
//   node scripts/updater-manifest.mjs <folder> <version> [notes-file]
//
// <folder> holds both platforms' staged files, as checked by
// `verify-artifacts.sh <platform> <folder> <version> updater`. The manifest is
// printed to stdout. Nothing is uploaded or published here (#259).
//
// It fails, and prints nothing, if any target's package or signature is
// missing, if a signature is bound to another version, or if a signature was
// made by a key other than the one embedded in src-tauri/tauri.conf.json (or
// UPDATER_PUBKEY, for tests).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decode,
  embeddedPubkey,
  keyId,
  signedVersion,
  verifies,
} from "./minisign.mjs";

const [dir, version, notesFile] = process.argv.slice(2);
const repository =
  process.env.GITHUB_REPOSITORY ?? "arlecchinoOPSource/Unhollowed-2";
// The release that holds the packages: v<version>, or an isolated dry-run
// release (U2-P7-07).
const releaseTag = process.env.UPDATER_RELEASE_TAG ?? `v${version}`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!dir || !version)
  fail("usage: updater-manifest.mjs <folder> <version> [notes-file]");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
  fail(`'${version}' is not a SemVer version.`);

// Staged names use the product name; release assets replace its space with a
// hyphen, as the v1.0.0-beta.1 assets do.
const packages = {
  macos: `Unhollowed 2_${version}_aarch64.app.tar.gz`,
  nsis: `Unhollowed 2_${version}_x64-setup.exe`,
  msi: `Unhollowed 2_${version}_x64_en-US.msi`,
};
// The plugin looks for `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
// Each installer family gets its own key so an MSI install never receives the
// NSIS setup. The plain Windows key points at NSIS, the primary installer.
const targets = {
  "darwin-aarch64": packages.macos,
  "darwin-aarch64-app": packages.macos,
  "windows-x86_64": packages.nsis,
  "windows-x86_64-nsis": packages.nsis,
  "windows-x86_64-msi": packages.msi,
};

const pubkey = embeddedPubkey();
const expectedKey = keyId(decode(pubkey));
if (expectedKey.length !== 16) fail("Could not read the updater public key.");

const signatures = {};
for (const name of Object.values(packages)) {
  if (!existsSync(join(dir, name))) fail(`Missing updater package: ${name}`);
  const sigPath = join(dir, `${name}.sig`);
  if (!existsSync(sigPath)) fail(`Missing updater signature: ${name}.sig`);
  const signature = readFileSync(sigPath, "utf8").trim();
  const text = decode(signature);
  if (signedVersion(text) !== version)
    fail(`${name}.sig is not bound to version ${version}.`);
  if (keyId(text) !== expectedKey)
    fail(`${name}.sig was made by a different key than the embedded one.`);
  if (!verifies(readFileSync(join(dir, name)), signature, pubkey))
    fail(`${name}.sig does not match the package.`);
  signatures[name] = signature;
}

const asset = (name) =>
  `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(name.replaceAll(" ", "-"))}`;

const manifest = {
  version,
  notes: notesFile ? readFileSync(notesFile, "utf8").trim() : "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: Object.fromEntries(
    Object.entries(targets).map(([target, name]) => [
      target,
      { url: asset(name), signature: signatures[name] },
    ]),
  ),
};
console.log(JSON.stringify(manifest, null, 2));
