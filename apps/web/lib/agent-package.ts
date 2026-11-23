/**
 * Encrypted agent packages for paid copies. The creator's browser encrypts the .nomad file (AES-256-GCM, a new
 * random key for each package) before it leaves the computer; the encrypted file goes to IPFS, where anyone can
 * fetch it but no one can read it without the key; the key is released only to a wallet that owns the agent or has
 * a copy. The buyer's browser decrypts it and checks it against the SHA-256 recorded on-chain.
 * Runs in the browser and on the server (Web Crypto in both).
 */
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 - 64; // under Vercel's 4.5 MB request limit, with the header
const MAGIC = new TextEncoder().encode("NOMADENC1");
const IV_BYTES = 12;
export const SIGNED_MAX_AGE_MS = 10 * 60 * 1000;

export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export async function sha256Hex(bytes: Uint8Array): Promise<`0x${string}`> {
  return `0x${toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))}`;
}

/** Whether these bytes start like an encrypted Nomad package. */
export function looksEncrypted(blob: Uint8Array): boolean {
  return blob.length > MAGIC.length + IV_BYTES + 16 && MAGIC.every((b, i) => blob[i] === b);
}

/** Encrypts a package. Returns the encrypted file and its key (64 hex characters). */
export async function encryptPackage(plain: Uint8Array): Promise<{ blob: Uint8Array; keyHex: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  const blob = new Uint8Array(MAGIC.length + IV_BYTES + ct.length);
  blob.set(MAGIC, 0);
  blob.set(iv, MAGIC.length);
  blob.set(ct, MAGIC.length + IV_BYTES);
  return { blob, keyHex: toHex(keyBytes) };
}

/** Decrypts a package; throws when the file or key is wrong (AES-GCM checks both). */
export async function decryptPackage(blob: Uint8Array, keyHex: string): Promise<Uint8Array> {
  if (!looksEncrypted(blob)) throw new Error("This is not an encrypted Nomad package.");
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error("The key is not valid.");
  const key = await crypto.subtle.importKey("raw", fromHex(keyHex) as BufferSource, "AES-GCM", false, ["decrypt"]);
  const iv = blob.slice(MAGIC.length, MAGIC.length + IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, blob.slice(MAGIC.length + IV_BYTES) as BufferSource));
}

/** What the creator signs to store a package's key. */
export const storeMessage = (packageHash: string, address: string, issuedAt: string) =>
  `Nomad: store the key of the encrypted agent package ${packageHash.toLowerCase()} for ${address.toLowerCase()}, at ${issuedAt}. This signature costs nothing and sends nothing.`;

/** What a buyer signs to get an agent's key. */
export const openMessage = (id: number, address: string, issuedAt: string) =>
  `Nomad: open minted agent #${id} for ${address.toLowerCase()}, at ${issuedAt}. This signature costs nothing and sends nothing.`;

/** A CIDv0 or CIDv1 (base32 or base58) as IPFS gives it. */
export const isCid = (s: unknown) => typeof s === "string" && /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,100})$/.test(s);

/** Public IPFS gateways to fetch encrypted packages from, in order. */
export const GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
