import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptPackage, encryptPackage, looksEncrypted, openMessage, sha256Hex, storeMessage } from "../../apps/web/lib/agent-package";
import { KeyError, releaseKey, storePackage, UPLOADS_PER_DAY, type Deps, type OnChainAgent } from "../../apps/web/lib/server/agent-keys";
import { MemoryRedis } from "../../apps/web/lib/redis";
import { parsePartners, safeUri } from "../../apps/web/lib/economy";

/** Paid copies: only a wallet that owns the agent, created it or has a copy gets the key; the file is checked. */
const creator = privateKeyToAccount(keccak256(toHex("paid-copies-creator")));
const buyer = privateKeyToAccount(keccak256(toHex("paid-copies-buyer")));
const stranger = privateKeyToAccount(keccak256(toHex("paid-copies-stranger")));
const NOW = new Date("2026-11-23T10:00:00.000Z");
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const plain = new TextEncoder().encode(JSON.stringify({ agent: "Pip", files: ["SOUL.md"] }));

type World = { agents: Map<number, OnChainAgent>; byHash: Map<string, number>; uploads: Uint8Array[] };
function deps(world: World, redis = new MemoryRedis()): Deps {
  return {
    redis,
    now: () => NOW,
    upload: async (b) => {
      world.uploads.push(b);
      return CID;
    },
    readAgent: async (id, address) => {
      const a = world.agents.get(id);
      return a ? { ...a, hasCopy: a.hasCopy && address.toLowerCase() === buyer.address.toLowerCase() } : null;
    },
    agentOfPackage: async (h) => {
      const id = world.byHash.get(h.toLowerCase()) ?? 0;
      return { id, creator: id ? world.agents.get(id)!.creator : null };
    }
  };
}
const sign = (acct: typeof creator, message: string) => acct.signMessage({ message });

async function stored(world: World, d: Deps) {
  const packageHash = await sha256Hex(plain);
  const { blob, keyHex } = await encryptPackage(plain);
  const issuedAt = NOW.toISOString();
  const out = await storePackage(d, { packageHash, keyHex, address: creator.address, issuedAt, signature: await sign(creator, storeMessage(packageHash, creator.address, issuedAt)), blob });
  return { packageHash, keyHex, blob, out };
}

describe("encryption", () => {
  it("round-trips, and a wrong key or a changed file fails", async () => {
    const { blob, keyHex } = await encryptPackage(plain);
    expect(looksEncrypted(blob)).toBe(true);
    expect(Buffer.from(blob).includes(Buffer.from("SOUL.md"))).toBe(false);
    expect(await decryptPackage(blob, keyHex)).toEqual(plain);
    await expect(decryptPackage(blob, "00".repeat(32))).rejects.toThrow();
    const changed = blob.slice();
    changed[changed.length - 1] ^= 1;
    await expect(decryptPackage(changed, keyHex)).rejects.toThrow();
    await expect(decryptPackage(plain, keyHex)).rejects.toThrow("not an encrypted");
  });
});

describe("storing a package", () => {
  it("stores the encrypted file on IPFS and the key for the signing wallet", async () => {
    const world: World = { agents: new Map(), byHash: new Map(), uploads: [] };
    const { out, blob } = await stored(world, deps(world));
    expect(out).toEqual({ cid: CID, uri: `ipfs://${CID}` });
    expect(world.uploads[0]).toEqual(blob);
  });

  it("refuses a plain file, a bad or old signature, another wallet's package, and too many uploads", async () => {
    const world: World = { agents: new Map(), byHash: new Map(), uploads: [] };
    const redis = new MemoryRedis();
    const d = deps(world, redis);
    const packageHash = await sha256Hex(plain);
    const { blob, keyHex } = await encryptPackage(plain);
    const at = NOW.toISOString();
    const good = await sign(creator, storeMessage(packageHash, creator.address, at));
    const base = { packageHash, keyHex, address: creator.address, issuedAt: at, signature: good, blob };
    await expect(storePackage(d, { ...base, blob: plain })).rejects.toThrow("Only encrypted");
    await expect(storePackage(d, { ...base, signature: await sign(stranger, storeMessage(packageHash, creator.address, at)) })).rejects.toThrow("not from that wallet");
    const old = "2026-11-23T09:40:00.000Z";
    await expect(storePackage(d, { ...base, issuedAt: old, signature: await sign(creator, storeMessage(packageHash, creator.address, old)) })).rejects.toThrow("too old");
    await storePackage(d, base);
    await expect(storePackage(d, { ...base, address: stranger.address, signature: await sign(stranger, storeMessage(packageHash, stranger.address, at)) })).rejects.toThrow("another wallet");
    for (let i = 1; i < UPLOADS_PER_DAY; i++) await storePackage(d, base);
    await expect(storePackage(d, base)).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a package someone else already minted", async () => {
    const packageHash = await sha256Hex(plain);
    const world: World = { agents: new Map([[1, { creator: stranger.address, packageHash, price: 0n, owner: stranger.address, hasCopy: false }]]), byHash: new Map([[packageHash, 1]]), uploads: [] };
    await expect(stored(world, deps(world))).rejects.toThrow("already minted by another wallet");
  });
});

describe("releasing a key", () => {
  async function setup(price: bigint, hasCopy: boolean) {
    const world: World = { agents: new Map(), byHash: new Map(), uploads: [] };
    const redis = new MemoryRedis();
    const d = deps(world, redis);
    const s = await stored(world, d);
    world.agents.set(1, { creator: creator.address, packageHash: s.packageHash, price, owner: creator.address, hasCopy });
    world.byHash.set(s.packageHash, 1);
    const ask = async (acct: typeof creator, id = 1) => releaseKey(d, { id, address: acct.address, issuedAt: NOW.toISOString(), signature: await sign(acct, openMessage(id, acct.address, NOW.toISOString())) });
    return { ...s, d, world, ask };
  }

  it("gives the key to a buyer with a copy and to the creator, and the file decrypts to the recorded hash", async () => {
    const s = await setup(500n, true);
    const k = await s.ask(buyer);
    expect(k).toEqual({ key: s.keyHex, cid: CID, packageHash: s.packageHash });
    const opened = await decryptPackage(s.blob, k.key);
    expect(await sha256Hex(opened)).toBe(s.packageHash);
    expect((await s.ask(creator)).key).toBe(s.keyHex);
  });

  it("refuses a wallet without a copy, a missing agent and a signature for another agent", async () => {
    const s = await setup(500n, false);
    await expect(s.ask(stranger)).rejects.toMatchObject({ status: 403 });
    await expect(s.ask(buyer, 2)).rejects.toMatchObject({ status: 404 });
    const sig = await sign(buyer, openMessage(2, buyer.address, NOW.toISOString()));
    await expect(releaseKey(s.d, { id: 1, address: buyer.address, issuedAt: NOW.toISOString(), signature: sig })).rejects.toBeInstanceOf(KeyError);
  });

  it("free agents open for anyone who signs", async () => {
    const s = await setup(0n, false);
    expect((await s.ask(stranger)).key).toBe(s.keyHex);
  });

  it("a key stored by someone other than the agent's creator is never released", async () => {
    const s = await setup(0n, false);
    s.world.agents.set(1, { ...s.world.agents.get(1)!, creator: stranger.address });
    await expect(s.ask(buyer)).rejects.toThrow("not stored by this agent's creator");
  });
});

describe("what the site shows", () => {
  it("package links are https or ipfs addresses only", () => {
    expect(safeUri(`ipfs://${CID}`)).toBe(`ipfs://${CID}`);
    expect(safeUri("https://example.com/pip.nomad")).toBe("https://example.com/pip.nomad");
    for (const bad of ["javascript:alert(1)", "ipfs://notacid", "http://example.com/x", `ipfs://${CID}/../x`]) expect(safeUri(bad), bad).toBe("");
  });

  it("partner usage: known partners only, whole counts, most used first", () => {
    expect(parsePartners({ rushr: 12, stoa: 3, oddsengine: 12, evil: 99, oak: -1, hey: 1.5 })).toEqual([
      { id: "oddsengine", name: "OddsEngine", calls: 12 },
      { id: "rushr", name: "Rushr", calls: 12 },
      { id: "stoa", name: "Stoa", calls: 3 }
    ]);
  });
});
