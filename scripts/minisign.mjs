// Tauri updater signatures are base64 of minisign text (U2-P7-03, U2-P7-07).
// These helpers read them and verify them the way the app's plugin does:
// Ed25519 over the BLAKE2b-512 digest of the file ("ED"), plus the global
// signature over the signature and its trusted comment, which names the version.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const decode = (text) =>
  Buffer.from(text.trim(), "base64").toString("utf8");

const bytes = (minisign, line) =>
  Buffer.from(minisign.split("\n")[line] ?? "", "base64");

/** The 8-byte key ID of a decoded key or signature, as hex. */
export const keyId = (minisign) =>
  bytes(minisign, 1).subarray(2, 10).toString("hex");

/** The version a decoded signature was bound to, from its trusted comment. */
export const signedVersion = (minisign) =>
  minisign
    .split("\n")
    .find((line) => line.startsWith("trusted comment: "))
    ?.match(/\tversion:(\S+)$/)?.[1];

/** The public key embedded in the app, or UPDATER_PUBKEY (for tests). */
export const embeddedPubkey = () =>
  process.env.UPDATER_PUBKEY ??
  JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"))
    .plugins.updater.pubkey;

/** True when `signature` (base64, as in a .sig file) signs `data` with `pubkey`. */
export function verifies(data, signature, pubkey) {
  const key = bytes(decode(pubkey), 1);
  const text = decode(signature);
  const sig = bytes(text, 1);
  const comment = (text.split("\n")[2] ?? "").replace(/^trusted comment: /, "");
  if (sig.length !== 74 || key.length !== 42) return false;
  if (sig.subarray(0, 2).toString() !== "ED") return false;
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) return false;
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const digest = createHash("blake2b512").update(data).digest();
  return (
    verify(null, digest, publicKey, sig.subarray(10)) &&
    verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(comment)]),
      publicKey,
      bytes(text, 3),
    )
  );
}
