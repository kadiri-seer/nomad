import { describe, expect, it } from "vitest";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG } from "../../apps/web/lib/accounts/chain";
import type { AgentRecord } from "../../apps/web/lib/agents/shared";
import { validHires } from "../../apps/web/lib/agents/shared";
import { agentStore } from "../../apps/web/lib/server/agents-store";
import { runAgent, type RunnerDeps } from "../../apps/web/lib/server/runner";
import { readAgent, zerolux, ZEROLUX_FACTORIES, type HireResult, type ZeroLuxAgent } from "../../apps/web/lib/server/zerolux";
import { zeroluxCheck } from "../../apps/web/lib/server/agent-health";
import { MemoryRedis } from "../../apps/web/lib/redis";

const payer = privateKeyToAccount(`0x${"55".repeat(32)}`);
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
// Zero Lux's real v4 factory, which Nomad pins.
const FACTORY4 = getAddress("0xe645344552bd46BF170D55819850612D22349c0A");
const OWNER = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const DOMAIN = { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG };
const RECEIVE = { ReceiveWithAuthorization: ["from", "to", "value", "validAfter", "validBefore", "nonce"].map((name, i) => ({ name, type: i < 2 ? "address" : i === 5 ? "bytes32" : "uint256" })) };

/** Zero Lux's API as its source answers (Nov 27, 2026): /api/agents, /api/config and /a/{id}/run. */
function fakeZeroLux(o: { factory?: string; terms?: (t: Record<string, any>) => Record<string, any>; again?: number; fail?: string; version?: number } = {}) {
  const seen: { path: string; payment: string | null }[] = [];
  let again = o.again ?? 0;
  const agents = [
    { id: 15, name: "Token Brief", tagline: "A one-page brief on any Robinhood Chain token", price: "100000", version: o.version ?? 4, wallet: WALLET, status: "live", runs: 40, model: "Smart", tools: ["web_search"] },
    { id: 9, name: "Old Agent", tagline: "token notes", price: "50000", version: 2, wallet: WALLET, status: "live", runs: 900 },
    { id: 7, name: "Pricey", tagline: "token deep dive", price: "2000000", version: 4, wallet: WALLET, status: "live", runs: 3 }
  ];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const payment = new Headers(init.headers).get("x-payment");
    seen.push({ path, payment });
    if (path === "/api/agents") return Response.json({ agents });
    if (path === "/api/config") return Response.json({ factoryByVersion: { 2: null, 3: null, 4: o.factory ?? FACTORY4 } });
    if (path === "/a/15/run") {
      if (!payment) {
        const t = {
          x402Version: 1,
          accepts: [{ scheme: "exact", network: "eip155:4663", maxAmountRequired: "100000", payTo: WALLET, asset: USDG }],
          sign: { domain: DOMAIN, types: RECEIVE, primaryType: "ReceiveWithAuthorization", message: { to: WALLET, value: "100000", validAfter: "0" } }
        };
        return Response.json(o.terms ? o.terms(t) : t, { status: 402 });
      }
      if (o.fail) return Response.json({ error: o.fail, final: true }, { status: 409 });
      if (again-- > 0) return Response.json({ error: "Working.", again: true }, { status: 503, headers: { "retry-after": "1" } });
      return Response.json({ output: "Brief: steady volume, no red flags.", run: "r1", paid: "100000", tx: `0x${"ab".repeat(32)}`, agent: { id: 15, name: "Token Brief" } });
    }
    return Response.json({ error: "no" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const client = (f: ReturnType<typeof fakeZeroLux>, wallets: Address[] = [WALLET]) =>
  zerolux(payer, { fetchImpl: f.fetchImpl, isAgentWallet: async (factory, w) => factory === FACTORY4 && wallets.includes(w), sleep: async () => undefined });

describe("Zero Lux: hiring", () => {
  it("lists only live agents that refund (version 4 and later)", async () => {
    const list = await client(fakeZeroLux()).agents();
    expect(list.map((a) => a.id)).toEqual([15, 7]);
    expect(list[0]).toMatchObject({ name: "Token Brief", price: 100000n, wallet: WALLET });
    expect(readAgent({ id: 1, status: "live", version: 4, wallet: "nope", price: "1" })).toBeNull();
  });

  it("signs exactly the listed price to the agent's wallet in the receive form, then collects the answer", async () => {
    const f = fakeZeroLux({ again: 2 });
    const zl = client(f);
    const [a] = await zl.agents();
    const r = await zl.hire(a, "Brief me on HOOKR.", 250_000n);
    expect(r).toMatchObject({ status: "done", output: "Brief: steady volume, no red flags.", paid: 100000n });
    const paid = f.seen.filter((s) => s.payment);
    expect(paid).toHaveLength(3);
    expect(new Set(paid.map((p) => p.payment)).size).toBe(1); // the same payment each time: never charged twice
    const p = JSON.parse(Buffer.from(paid[0].payment!, "base64").toString());
    expect(p).toMatchObject({ x402Version: 1, scheme: "exact", network: "eip155:4663" });
    const auth = p.payload.authorization;
    expect(auth).toMatchObject({ from: payer.address, to: WALLET, value: "100000", validAfter: "0" });
    const typed = {
      address: payer.address,
      domain: DOMAIN,
      types: RECEIVE,
      primaryType: "ReceiveWithAuthorization",
      message: { ...auth, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore) },
      signature: p.payload.signature as Hex
    };
    expect(await verifyTypedData(typed as Parameters<typeof verifyTypedData>[0])).toBe(true);
  });

  it("signs nothing when the terms or the wallet are not what the listing says", async () => {
    const cases: ((t: Record<string, any>) => Record<string, any>)[] = [
      (t) => ({ ...t, accepts: [{ ...t.accepts[0], payTo: OWNER }] }),
      (t) => ({ ...t, accepts: [{ ...t.accepts[0], maxAmountRequired: "200000" }] }),
      (t) => ({ ...t, sign: { ...t.sign, primaryType: "TransferWithAuthorization" } }),
      (t) => ({ ...t, sign: { ...t.sign, domain: { ...t.sign.domain, chainId: 8453 } } }),
      (t) => ({ ...t, sign: { ...t.sign, message: { ...t.sign.message, to: OWNER } } })
    ];
    for (const terms of cases) {
      const f = fakeZeroLux({ terms });
      const zl = client(f);
      const r = await zl.hire((await zl.agents())[0], "x", 250_000n);
      expect(r).toMatchObject({ status: "failed", paid: false });
      expect(f.seen.some((s) => s.payment)).toBe(false);
    }
    const f = fakeZeroLux();
    const fake = client(f, []);
    expect(await fake.hire((await fake.agents())[0], "x", 250_000n)).toMatchObject({ status: "failed", reason: expect.stringMatching(/not one of Zero Lux's own/), paid: false });
    expect(f.seen.some((s) => s.payment)).toBe(false);
    const g = fakeZeroLux();
    const zl = client(g);
    expect(await zl.hire((await zl.agents())[0], "x", 50_000n)).toMatchObject({ status: "failed", reason: expect.stringMatching(/above this agent's limit/) });
  });

  it("pays nothing when Zero Lux's API names another factory, even one that vouches for the wallet", async () => {
    const OTHER = getAddress("0x4444444444444444444444444444444444444444");
    const f = fakeZeroLux({ factory: OTHER });
    const zl = zerolux(payer, { fetchImpl: f.fetchImpl, isAgentWallet: async () => true, sleep: async () => undefined });
    expect(await zl.hire((await zl.agents())[0], "x", 250_000n)).toMatchObject({ status: "failed", reason: expect.stringMatching(/not one of Zero Lux's own/), paid: false });
    expect(f.seen.some((s) => s.payment)).toBe(false);
  });

  it("hands back a slow run as pending, and says when Zero Lux charged nothing", async () => {
    let t = 0;
    const timed = zerolux(payer, { fetchImpl: fakeZeroLux({ again: 1000 }).fetchImpl, isAgentWallet: async () => true, sleep: async () => void (t += 10_000), now: () => t });
    const r = await timed.hire((await timed.agents())[0], "x", 250_000n, 30_000);
    expect(r.status).toBe("pending");
    const nothing = client(fakeZeroLux({ fail: "No money moved, so nothing ran." }));
    expect(await nothing.hire((await nothing.agents())[0], "x", 250_000n)).toMatchObject({ status: "failed", paid: false });
    const kept = client(fakeZeroLux({ fail: "This payment has used all of its tries." }));
    expect(await kept.hire((await kept.agents())[0], "x", 250_000n)).toMatchObject({ status: "failed", paid: true });
  });

  it("creators choose the limits; off unless they turn it on", () => {
    expect(validHires(null)).toBeNull();
    expect(validHires({ perDay: 0 })).toBeNull();
    expect(validHires({ perDay: 3, maxUsd: "0.25" })).toEqual({ perDay: 3, maxUsd: "0.25" });
    expect(() => validHires({ perDay: 11, maxUsd: "0.25" })).toThrow(/between 0 and 10/);
    expect(() => validHires({ perDay: 3, maxUsd: "5" })).toThrow(/between 0.05 and 1.00/);
  });
});

describe("Zero Lux: an agent's run", () => {
  const TB: ZeroLuxAgent = { id: 15, name: "Token Brief", tagline: "A brief on any token", price: 100_000n, version: 4, wallet: WALLET, runs: 40, model: null, tools: [] };
  const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
    id: "4",
    name: "Scout",
    template: "researcher",
    limits: { perTradeUsd: "0.30", tradesPerDay: 3 },
    runEveryHours: 6,
    status: "active",
    owner: OWNER,
    signer: OWNER,
    account: WALLET,
    salt: "1",
    deferredAction: "0x00",
    sessionAddress: OWNER,
    sessionEntityId: 1,
    sessionDeadline: 2_000_000_000,
    packageHash: "0x00",
    mintTx: "0x00",
    createdAt: 0,
    hires: { perDay: 2, maxUsd: "0.25" },
    ...over
  });
  function harness(o: { hire?: (a: ZeroLuxAgent) => HireResult; collect?: () => HireResult; credits?: bigint; asks?: { id: number; input: string }[][] }) {
    const store = agentStore(new MemoryRedis());
    let credits = o.credits ?? 1_000_000n;
    const hired: number[] = [];
    let call = 0;
    const d: RunnerDeps = {
      store,
      now: () => 1_800_000_000_000,
      credits: {
        available: async () => credits,
        charge: async (_o, m) => (credits >= m ? ((credits -= m), true) : false),
        refund: async (_o, m) => void (credits += m)
      },
      balanceOf: async () => 0n,
      quote: async () => {
        throw new Error("no trading here");
      },
      candidates: async () => [],
      sender: async () => ({ send: async () => `0x${"00".repeat(32)}` as Hex }),
      ai: {
        name: "Gemini",
        ask: async () => "nothing",
        // A model that hires what the test says, through the tools it was given.
        withTools: async (_p, _s, _l, extra) => {
          const asks = o.asks?.[call++] ?? [];
          const answers: string[] = [];
          if (asks.length) answers.push(await extra![0].run({ query: "token" }));
          for (const a of asks) answers.push(await extra![1].run(a));
          return { text: `REPORT: ${answers.join(" | ").slice(0, 300)}`, used: [], calls: [] };
        }
      },
      idlex: null,
      zerolux: {
        agents: async () => [TB],
        hire: async (a) => (hired.push(a.id), o.hire ? o.hire(a) : { status: "done", output: "Steady volume.", run: "r1", tx: `0x${"ab".repeat(32)}`, paid: a.price }),
        collect: async () => (o.collect ? o.collect() : { status: "done", output: "Late answer.", run: "r2", tx: null, paid: 100_000n })
      }
    };
    return { d, store, hired, credits: () => credits };
  }

  it("hires within the creator's limits, paid from credits first", async () => {
    const h = harness({ asks: [[{ id: 15, input: "Brief me on HOOKR." }]] });
    const notes = await runAgent(h.d, agent());
    expect(h.hired).toEqual([15]);
    expect(h.credits()).toBe(900_000n);
    expect(notes.join("\n")).toMatch(/Hired Zero Lux agent Token Brief \(#15\) for 0\.10 USDG/);
  });

  it("gives credits back when a hire fails, and hires nothing when hiring is off", async () => {
    const h = harness({ hire: () => ({ status: "failed", reason: "It is busy.", paid: false }), asks: [[{ id: 15, input: "x" }]] });
    const notes = await runAgent(h.d, agent());
    expect(h.credits()).toBe(1_000_000n);
    expect(notes.join("\n")).toMatch(/Could not hire Zero Lux agent Token Brief: It is busy\. Its credits were given back/);
    const off = harness({ asks: [] });
    let tools: unknown[] | undefined;
    off.d.ai!.withTools = async (_p, _s, _l, extra) => ((tools = extra), { text: "REPORT: ok", used: [], calls: [] });
    await runAgent(off.d, agent({ hires: undefined }));
    expect(tools).toEqual([]);
  });

  it("stops at the creator's number a day, two a run, and short credits", async () => {
    const h = harness({ asks: [[{ id: 15, input: "a" }, { id: 15, input: "b" }, { id: 15, input: "c" }]] });
    await runAgent(h.d, agent({ hires: { perDay: 5, maxUsd: "0.25" } }));
    expect(h.hired).toHaveLength(2);
    const day = harness({ asks: [[{ id: 15, input: "a" }, { id: 15, input: "b" }]] });
    await runAgent(day.d, agent({ hires: { perDay: 1, maxUsd: "0.25" } }));
    expect(day.hired).toHaveLength(1);
    expect(day.credits()).toBe(900_000n);
    const poor = harness({ credits: 80_000n, asks: [[{ id: 15, input: "a" }]] });
    await runAgent(poor.d, agent());
    expect(poor.hired).toEqual([]);
    // An agent above the creator's price per hire is not offered.
    const cheap = harness({ asks: [[{ id: 15, input: "a" }]] });
    await runAgent(cheap.d, agent({ hires: { perDay: 2, maxUsd: "0.05" } }));
    expect(cheap.hired).toEqual([]);
  });

  it("a slow hire is collected on the next run, its answer kept in the agent's notes", async () => {
    const h = harness({ hire: (a) => ({ status: "pending", ticket: "t", paid: a.price }), asks: [[{ id: 15, input: "slow one" }], []] });
    const a = agent();
    await runAgent(h.d, a);
    const saved = (await h.store.get("4"))!;
    expect(saved.pendingHire).toMatchObject({ agent: 15, name: "Token Brief", input: "slow one", paid: "100000" });
    const notes = await runAgent(h.d, saved);
    expect(notes.join("\n")).toMatch(/Zero Lux agent Token Brief answered the hire from its last run/);
    expect((await h.store.get("4"))!.pendingHire).toBeUndefined();
    expect((await h.store.notes("4")).map((n) => n.text).join("\n")).toContain("Late answer.");
  });
});

describe("Zero Lux: the status check", () => {
  const cache = () => {
    const m = new Map<string, unknown>();
    return { cacheGet: async <T,>(k: string) => (m.get(k) as T) ?? null, cacheSet: async (k: string, v: unknown) => void m.set(k, v) };
  };
  const base = (over: Record<string, unknown> = {}) => {
    const f = fakeZeroLux();
    const zl = client(f);
    return {
      f,
      d: { enabled: true, payer: payer.address, agents: () => zl.agents(), factories: () => zl.factories(), pinned: ZEROLUX_FACTORIES, isAgentWallet: async (fac: string, w: string) => fac === FACTORY4 && w === WALLET, payerUsdg: async () => 1_000_000n, ...over }
    };
  };

  it("says hiring is ready without asking for a run or signing anything", async () => {
    const { f, d } = base();
    const r = await zeroluxCheck(cache(), d);
    expect(r).toMatchObject({ ok: true, spends: "nothing", hireable: 2, walletCheck: { agent: 15, isAgentWallet: true } });
    expect(f.seen.every((s) => !s.path.startsWith("/a/") && !s.payment)).toBe(true);
  });

  it("says why when it is not ready: an empty wallet, or a factory Nomad does not pin", async () => {
    expect(await zeroluxCheck(cache(), base({ payerUsdg: async () => 1_000n }).d)).toMatchObject({ ok: false, detail: expect.stringMatching(/less USDG/) });
    expect(await zeroluxCheck(cache(), base({ pinned: { 4: getAddress("0x4444444444444444444444444444444444444444") } }).d)).toMatchObject({ ok: false, detail: expect.stringMatching(/does not pin/) });
    expect(await zeroluxCheck(cache(), { ...base().d, enabled: false })).toMatchObject({ enabled: false });
  });
});
