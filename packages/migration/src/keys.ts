import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@nomad/core";
import type { Signature } from "@nomad/archive";

/**
 * Package signing with Ed25519. Each Nomad install can create one signing key,
 * kept in ~/.nomad/keys with owner-only permissions. A signature covers the
 * package manifest, which itself lists the SHA-256 of every file, so it covers
 * the whole package.
 */

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function fingerprintOf(rawKeyBase64: string): string {
  return sha256(new Uint8Array(Buffer.from(rawKeyBase64, "base64")))
    .slice(0, 16)
    .match(/.{4}/g)!
    .join(" ");
}

function keyPaths(home: string) {
  const dir = join(home, "keys");
  return { dir, priv: join(dir, "signing.pem"), pub: join(dir, "signing.pub") };
}

export interface SigningIdentity {
  key: string;
  fingerprint: string;
  created: boolean;
}

export function signingIdentity(home: string, create = true): SigningIdentity | null {
  const p = keyPaths(home);
  let created = false;
  if (!existsSync(p.priv)) {
    if (!create) return null;
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(p.priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(SPKI_PREFIX.length);
    writeFileSync(p.pub, raw.toString("base64") + "\n", { mode: 0o644 });
    created = true;
  }
  const key = readFileSync(p.pub, "utf8").trim();
  return { key, fingerprint: fingerprintOf(key), created };
}

export function signer(home: string): (payload: string) => Signature {
  const id = signingIdentity(home, true)!;
  const priv = createPrivateKey(readFileSync(keyPaths(home).priv));
  return (payload) => ({ alg: "ed25519", key: id.key, fingerprint: id.fingerprint, value: sign(null, Buffer.from(payload), priv).toString("base64") });
}

export function verifySignature(payload: string, sig: Signature): boolean {
  if (sig.alg !== "ed25519") return false;
  const raw = Buffer.from(sig.key, "base64");
  if (raw.length !== 32) return false;
  if (fingerprintOf(sig.key) !== sig.fingerprint) return false;
  const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return verify(null, Buffer.from(payload), pub, Buffer.from(sig.value, "base64"));
}

export interface TrustedKey {
  fingerprint: string;
  key: string;
  name: string;
}

export type SignerStatus =
  | { state: "unsigned" }
  | { state: "invalid"; fingerprint: string }
  | { state: "you"; fingerprint: string }
  | { state: "trusted"; fingerprint: string; name: string }
  | { state: "unknown"; fingerprint: string };

export function signerStatus(sig: { fingerprint: string; key: string; verified: boolean | null } | null | undefined, own: SigningIdentity | null, trusted: TrustedKey[]): SignerStatus {
  if (!sig) return { state: "unsigned" };
  if (sig.verified === false) return { state: "invalid", fingerprint: sig.fingerprint };
  if (own && own.key === sig.key) return { state: "you", fingerprint: sig.fingerprint };
  const t = trusted.find((k) => k.key === sig.key);
  if (t) return { state: "trusted", fingerprint: sig.fingerprint, name: t.name };
  return { state: "unknown", fingerprint: sig.fingerprint };
}

export function describeSigner(s: SignerStatus): string {
  switch (s.state) {
    case "unsigned":
      return "Not signed";
    case "invalid":
      return `Signature does not match (key ${s.fingerprint}). The package was changed after signing.`;
    case "you":
      return `Signed by you (${s.fingerprint})`;
    case "trusted":
      return `Signed by ${s.name} (${s.fingerprint})`;
    case "unknown":
      return `Signed by a key you have not trusted yet (${s.fingerprint})`;
  }
}
