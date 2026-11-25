/**
 * The server side of paid copies: it keeps each encrypted package's key and gives it only to a wallet that owns the
 * minted agent, created it, or has a copy (or to anyone when the agent is free), checked on-chain at the moment of
 * asking. Keys are stored in the site's Upstash database; packages go to IPFS through Filebase. Every dependency
 * comes in as an argument, so the rules can be tested without the network.
 */
import { createPublicClient, http, recoverMessageAddress, type Abi } from "viem";
import { AGENTS_ABI } from "../agents-contract";
import { MAX_PACKAGE_BYTES, SIGNED_MAX_AGE_MS, isCid, looksEncrypted, openMessage, storeMessage } from "../agent-package";
import type { RedisLike } from "../redis";
import { hashToObject } from "../redis";

export const RPC = "https://rpc.mainnet.chain.robinhood.com";
const KEY_PREFIX = "nomad:agentpkg:";
const RATE_PREFIX = "nomad:agentpkg-rate:";
export const UPLOADS_PER_DAY = 5;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export class KeyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type OnChainAgent = { creator: string; packageHash: string; price: bigint; owner: string; hasCopy: boolean };

export type Deps = {
  redis: RedisLike;
  /** The agent with this id, its owner and whether `address` has a copy; null when there is no such agent. */
  readAgent: (id: number, address: string) => Promise<OnChainAgent | null>;
  /** The agent minted for a package hash (0 when none) and its creator. */
  agentOfPackage: (packageHash: string) => Promise<{ id: number; creator: string | null }>;
  /** Stores bytes on IPFS and returns the CID. */
  upload: (bytes: Uint8Array) => Promise<string>;
  now?: () => Date;
};

async function checkSignature(message: string, address: string, issuedAt: string, signature: string, now: Date) {
  if (!ADDRESS.test(address)) throw new KeyError(400, "address must be a wallet address.");
  const t = Date.parse(issuedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(issuedAt) || !Number.isFinite(t)) throw new KeyError(400, "issuedAt must be a UTC time.");
  if (Math.abs(now.getTime() - t) > SIGNED_MAX_AGE_MS) throw new KeyError(401, "That signature is too old (or from the future). Sign again.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new KeyError(400, "signature is not a wallet signature.");
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    throw new KeyError(401, "The signature could not be checked.");
  }
  if (signer.toLowerCase() !== address.toLowerCase()) throw new KeyError(401, "The signature is not from that wallet.");
}

/**
 * Stores an encrypted package and its key, for the wallet that will mint it. Refused for a package already minted
 * by someone else, or already stored by another wallet, and limited to a few uploads a day per wallet.
 */
export async function storePackage(
  deps: Deps,
  input: { packageHash: string; keyHex: string; address: string; issuedAt: string; signature: string; blob: Uint8Array }
): Promise<{ cid: string; uri: string }> {
  const now = deps.now?.() ?? new Date();
  const { packageHash, keyHex, address, issuedAt, signature, blob } = input;
  if (!HASH.test(packageHash)) throw new KeyError(400, "packageHash must be the package's SHA-256 (0x and 64 hex digits).");
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new KeyError(400, "The key is not valid.");
  if (blob.length > MAX_PACKAGE_BYTES) throw new KeyError(413, "The package is larger than 4 MB.");
  if (!looksEncrypted(blob)) throw new KeyError(400, "Only encrypted packages are stored.");
  await checkSignature(storeMessage(packageHash, address, issuedAt), address, issuedAt, signature, now);
  const me = address.toLowerCase();

  const minted = await deps.agentOfPackage(packageHash);
  if (minted.id > 0 && minted.creator?.toLowerCase() !== me) throw new KeyError(409, `This package is already minted by another wallet, as agent #${minted.id}.`);
  const key = `${KEY_PREFIX}${packageHash.toLowerCase()}`;
  const existing = hashToObject(await deps.redis.cmd(["HGETALL", key]));
  if (existing.uploader && existing.uploader !== me) throw new KeyError(409, "This package was already stored by another wallet.");

  const day = now.toISOString().slice(0, 10);
  const rate = `${RATE_PREFIX}${me}:${day}`;
  const n = Number(await deps.redis.cmd(["INCR", rate]));
  if (n === 1) await deps.redis.cmd(["EXPIRE", rate, 2 * 86400]);
  if (n > UPLOADS_PER_DAY) throw new KeyError(429, `At most ${UPLOADS_PER_DAY} packages a day per wallet.`);

  const cid = await deps.upload(blob);
  if (!isCid(cid)) throw new KeyError(502, "IPFS did not return a valid address for the file.");
  for (const [f, v] of [["key", keyHex.toLowerCase()], ["cid", cid], ["uploader", me], ["at", now.toISOString()]]) await deps.redis.cmd(["HSET", key, f, v]);
  return { cid, uri: `ipfs://${cid}` };
}

/** Gives the key of a minted agent's package to a wallet that may open it. */
export async function releaseKey(
  deps: Deps,
  input: { id: number; address: string; issuedAt: string; signature: string }
): Promise<{ key: string; cid: string; packageHash: string }> {
  const now = deps.now?.() ?? new Date();
  const { id, address, issuedAt, signature } = input;
  if (!Number.isSafeInteger(id) || id < 1) throw new KeyError(400, "id must be a minted agent's number.");
  await checkSignature(openMessage(id, address, issuedAt), address, issuedAt, signature, now);
  const me = address.toLowerCase();
  const agent = await deps.readAgent(id, address);
  if (!agent) throw new KeyError(404, "There is no minted agent with that number.");
  const allowed = agent.price === 0n || agent.hasCopy || agent.owner.toLowerCase() === me || agent.creator.toLowerCase() === me;
  if (!allowed) throw new KeyError(403, "This wallet does not have a copy of this agent yet. Get a copy first.");
  const rec = hashToObject(await deps.redis.cmd(["HGETALL", `${KEY_PREFIX}${agent.packageHash.toLowerCase()}`]));
  if (!rec.key || !rec.cid) throw new KeyError(404, "This agent's package was not stored encrypted with Nomad.");
  // Only the key its own creator stored counts, so no one else can attach a key to someone's agent.
  if (rec.uploader !== agent.creator.toLowerCase()) throw new KeyError(409, "The stored package was not stored by this agent's creator.");
  return { key: rec.key, cid: rec.cid, packageHash: agent.packageHash.toLowerCase() };
}

/** Reads the NomadAgents contract over the public RPC. */
export function chainReader(contract: string, rpc = RPC): Pick<Deps, "readAgent" | "agentOfPackage"> {
  const client = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) });
  const abi = AGENTS_ABI as unknown as Abi;
  const read = <T,>(functionName: string, args: unknown[]) => client.readContract({ address: contract as `0x${string}`, abi, functionName, args }) as Promise<T>;
  return {
    async readAgent(id, address) {
      const total = await read<bigint>("totalMinted", []);
      if (BigInt(id) > total) return null;
      const [a, owner, hasCopy] = await Promise.all([
        read<{ creator: string; packageHash: string; price: bigint }>("agent", [BigInt(id)]),
        read<string>("ownerOf", [BigInt(id)]),
        read<boolean>("hasCopy", [BigInt(id), address])
      ]);
      return { creator: a.creator, packageHash: a.packageHash, price: a.price, owner, hasCopy };
    },
    async agentOfPackage(packageHash) {
      const id = Number(await read<bigint>("agentOfPackage", [packageHash]));
      if (id === 0) return { id: 0, creator: null };
      const a = await read<{ creator: string }>("agent", [BigInt(id)]);
      return { id, creator: a.creator };
    }
  };
}

/** Uploads to IPFS through Filebase's IPFS RPC API (the key is FILEBASE_IPFS_TOKEN). */
export function filebaseUpload(token: string, fetchImpl: typeof fetch = fetch): Deps["upload"] {
  return async (bytes) => {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), "agent.nomad.enc");
    const r = await fetchImpl("https://rpc.filebase.io/api/v0/add?cid-version=1", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new KeyError(502, `IPFS storage answered ${r.status}.`);
    const text = await r.text();
    const line = text.trim().split("\n").pop() ?? "";
    let hash: unknown;
    try {
      hash = (JSON.parse(line) as { Hash?: unknown }).Hash;
    } catch {
      hash = undefined;
    }
    if (!isCid(hash)) throw new KeyError(502, "IPFS storage did not return a file address.");
    return hash as string;
  };
}
