import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entrantMessage, handInFingerprint, linkMessage, walletProofMessage, type Bounty, type HandInFields } from "../../apps/web/lib/bounties/shared";
import { bounties, bountyStore, type BountyDeps } from "../../apps/web/lib/server/bounties";
import { USDG } from "../../apps/web/lib/accounts/chain";
import type { RepoResult } from "../../apps/web/lib/server/repo-check";
import { MemoryRedis } from "../../apps/web/lib/redis";

const DAY = 86_400_000;
const OPENS = Date.parse("2026-11-30T15:00:00Z");
const NOW = OPENS + DAY;
const person = privateKeyToAccount(`0x${"11".repeat(32)}`);
const rival = privateKeyToAccount(`0x${"22".repeat(32)}`);
const agentKey = privateKeyToAccount(`0x${"33".repeat(32)}`);
const rivalAgent = privateKeyToAccount(`0x${"34".repeat(32)}`);
const relayer = "0x9999999999999999999999999999999999999999" as Address;
const SERVICE = { id: "ed1bd215", name: "Stoa trade brief (example)", wallet: getAddress("0x198c5C93259BEacd55862B8bEA0474a78441f995"), price: "0.01" };
const ACCOUNT = (signer: Address) => getAddress(`0x${signer.slice(2, 10).toLowerCase()}${"0".repeat(32)}`);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const payLog = (from: Address, to: Address, value: bigint) => ({
  address: USDG as Address,
  topics: encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value])
});

const STOA: Bounty = {
  id: "stoa-gasless",
  title: "Pay a Stoa agent service gaslessly with USDG",
  brief: "Build a small agent that buys a Stoa agent service and pays in USDG with an EIP-3009 signature.",
  result: "A public repo, the payment tx hash, and the service result.",
  prize: { amount: "40", token: "USDG" },
  places: 5,
  opens: new Date(OPENS).toISOString(),
  closes: new Date(OPENS + 10 * DAY).toISOString(),
  handIn: { repo: true, payment: "stoa-gasless", result: true }
};
const REPO = "https://github.com/someone/stoa-gasless";
const GOOD_REPO: RepoResult = { checks: [{ name: "Public GitHub repo", ok: true }, { name: "README", ok: true }, { name: "No secrets committed", ok: true }] };

function setup(o: { receipts?: Record<string, Awaited<ReturnType<NonNullable<BountyDeps["receiptOf"]>>>>; repo?: (url: string) => Promise<RepoResult>; list?: Bounty[]; balance?: bigint } = {}) {
  let now = NOW;
  const receipts = o.receipts ?? {};
  const d: BountyDeps = {
    store: bountyStore(new MemoryRedis()),
    list: o.list ?? [STOA],
    reviewers: [],
    now: () => now,
    treasuryBalance: async () => o.balance ?? 1_000_000_000n,
    verify: (address, message, signature) => verifyMessage({ address, message, signature }),
    mainAccountOf: async (s) => ACCOUNT(s),
    agent: async () => null,
    txBy: async () => true,
    paid: async () => false,
    bullPlan: async () => Promise.reject(new Error("no Bull")),
    escrowCreated: async () => null,
    venin: async (_p, t) => (/ignore previous/i.test(t) ? 1 : 0),
    secrets: (t) => (/PRIVATE_KEY=0x[0-9a-f]{64}/i.test(t) ? 1 : 0),
    repoCheck: o.repo ?? (async () => GOOD_REPO),
    receiptOf: async (h) => receipts[h] ?? null,
    stoaServices: async () => [SERVICE]
  };
  const s = bounties(d);
  const step = async (label: string, body: Record<string, unknown>, who = person) =>
    s.entrant({ signer: who.address, ...body, at: now, signature: await who.signMessage({ message: entrantMessage(label, now) }) });
  const link = async (who = person, wallet = agentKey, proof?: Hex) =>
    s.link({
      signer: who.address,
      wallet: wallet.address,
      name: "Payer",
      at: now,
      signature: await who.signMessage({ message: linkMessage(wallet.address, "Payer", now) }),
      walletSignature: proof ?? (await wallet.signMessage({ message: walletProofMessage(wallet.address, ACCOUNT(who.address)) }))
    });
  const enter = (who = person, wallet = agentKey) => step(`enter ${STOA.id} ${wallet.address.toLowerCase()}`, { action: "enter", bounty: STOA.id, wallet: wallet.address }, who);
  const handIn = (fields: HandInFields, who = person, wallet = agentKey) =>
    step(`handin ${STOA.id} ${wallet.address.toLowerCase()} ${handInFingerprint(fields)}`, { action: "handin", bounty: STOA.id, wallet: wallet.address, fields }, who) as Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[]; triesLeft?: number }>;
  const mine = (who = person) => step("mine", { action: "mine" }, who) as Promise<{ links: { wallet: string; proven: boolean }[]; entries: { bounty: string; triesLeft: number; submitted?: unknown; checks?: unknown }[] }>;
  return { s, d, step, link, enter, handIn, mine, receipts, setNow: (t: number) => (now = t) };
}

const gasless = (from: Address, time = NOW - 1000) => ({ status: "success", from: relayer, logs: [payLog(from, SERVICE.wallet, 10_000n)], time });

describe("bounty hand-in from the account page: the wallet proves itself once", () => {
  it("links with the wallet's own signature, and refuses one from another wallet", async () => {
    const t = setup();
    const wrong = await rival.signMessage({ message: walletProofMessage(agentKey.address, ACCOUNT(person.address)) });
    await expect(t.link(person, agentKey, wrong)).rejects.toThrow(/not from this wallet/);
    expect(await t.link()).toMatchObject({ ok: true, proven: true });
    expect((await t.mine()).links).toEqual([{ wallet: agentKey.address, name: "Payer", proven: true }]);
  });

  it("a wallet linked without its signature cannot enter from the account page", async () => {
    const t = setup();
    await t.s.link({ signer: person.address, wallet: agentKey.address, name: "Payer", at: NOW, signature: await person.signMessage({ message: linkMessage(agentKey.address, "Payer", NOW) }) });
    await expect(t.enter()).rejects.toThrow(/Prove this wallet/);
    await expect(t.enter(rival)).rejects.toThrow(/Link this wallet to your account first/);
  });
});

describe("bounty hand-in from the account page: the checks", () => {
  const good = (h = tx(1)): HandInFields => ({ repo: REPO, tx: h, result: "https://www.loom.com/share/abc" });

  it("takes a gasless Stoa payment, a public repo with a README and no secrets, and a result link", async () => {
    const t = setup({ receipts: { [tx(1)]: gasless(agentKey.address) } });
    await t.link();
    await t.enter();
    const r = await t.handIn(good());
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["Paid a Stoa agent service", true],
      ["Gasless", true],
      ["Paid after the bounty opened", true],
      ["Public GitHub repo", true],
      ["README", true],
      ["No secrets committed", true],
      ["Result link", true]
    ]);
    const e = (await t.d.store.entry(STOA.id, ACCOUNT(person.address)))!;
    expect(e.submission).toMatchObject({ proof: "onchain", txs: [tx(1)], fields: good() });
    expect((await t.s.publicList())[0]).toMatchObject({ entries: 1, handedIn: 1 });
    await expect(t.handIn(good())).rejects.toThrow(/already been handed in/);
  });

  it("missing fields are refused without using a try", async () => {
    const t = setup();
    await t.link();
    await t.enter();
    await expect(t.handIn({ tx: tx(1), result: "https://x.test/r" })).rejects.toThrow(/link to your repo/);
    await expect(t.handIn({ repo: REPO, result: "https://x.test/r" })).rejects.toThrow(/payment transaction/);
    await expect(t.handIn({ repo: REPO, tx: tx(1) })).rejects.toThrow(/link to the result/);
    await expect(t.handIn({ repo: REPO, tx: tx(1), result: "http://x.test/r" })).rejects.toThrow(/https/);
    expect((await t.mine()).entries[0].triesLeft).toBe(3);
  });

  it("a payment the wallet sent itself, or made before the bounty opened, does not pass and uses a try", async () => {
    const t = setup({ receipts: { [tx(2)]: { ...gasless(agentKey.address), from: agentKey.address }, [tx(3)]: gasless(agentKey.address, OPENS - 1000), [tx(4)]: gasless(rival.address) } });
    await t.link();
    await t.enter();
    const self = await t.handIn(good(tx(2)));
    expect(self).toMatchObject({ ok: false, triesLeft: 2 });
    expect(self.checks.find((c) => c.name === "Gasless")).toMatchObject({ ok: false });
    expect((await t.handIn(good(tx(3)))).checks.find((c) => c.name === "Paid after the bounty opened")).toMatchObject({ ok: false });
    // USDG from a different wallet is not this agent's payment.
    const other = await t.handIn(good(tx(4)));
    expect(other.checks[0]).toMatchObject({ name: "Paid a Stoa agent service", ok: false, detail: /No USDG left your linked wallet/ });
    // With nothing paid from the wallet, there is no gasless or timing result to show.
    expect(other.checks.map((c) => c.name)).not.toContain("Gasless");
    await expect(t.handIn(good(tx(1)))).rejects.toThrow(/out of tries/);
  });

  it("an unknown transaction, a repo with secrets, and a payment another entry already used do not pass", async () => {
    const t = setup({
      receipts: { [tx(5)]: gasless(agentKey.address), [tx(6)]: gasless(rivalAgent.address) },
      repo: async (url) => (url.endsWith("leaky") ? { checks: [{ name: "Public GitHub repo", ok: true }, { name: "README", ok: true }, { name: "No secrets committed", ok: false, detail: "Found Wallet private key in .env, line 1." }] } : GOOD_REPO)
    });
    await t.link();
    await t.enter();
    expect((await t.handIn(good(tx(9)))).checks[0]).toMatchObject({ ok: false, detail: /not found on Robinhood Chain/ });
    expect((await t.handIn({ ...good(tx(5)), repo: "https://github.com/someone/leaky" })).checks.find((c) => c.name === "No secrets committed")).toMatchObject({ ok: false, detail: /\.env/ });
    expect((await t.handIn(good(tx(5)))).ok).toBe(true);
    // Another entrant cannot hand in the same payment.
    await t.link(rival, rivalAgent);
    await t.enter(rival, rivalAgent);
    expect((await t.handIn(good(tx(5)), rival, rivalAgent)).checks[0]).toMatchObject({ name: "Payment", ok: false, detail: /another entry/ });
    expect((await t.handIn(good(tx(6)), rival, rivalAgent)).ok).toBe(true);
  });

  it("when GitHub cannot be reached, it says so and does not use a try", async () => {
    const t = setup({ receipts: { [tx(7)]: gasless(agentKey.address) }, repo: async () => ({ unavailable: "GitHub is limiting checks right now" }) });
    await t.link();
    await t.enter();
    await expect(t.handIn(good(tx(7)))).rejects.toThrow(/GitHub is limiting checks right now.*did not use a try/);
    expect((await t.mine()).entries[0].triesLeft).toBe(3);
  });

  it("a hash beside the word key in the note is not taken for a key, but a real key is", async () => {
    const t = setup({ receipts: { [tx(8)]: gasless(agentKey.address) } });
    await t.link();
    await t.enter();
    const leaked = await t.handIn({ ...good(tx(8)), note: `PRIVATE_KEY=0x${"ab".repeat(32)}` });
    expect(leaked.checks.find((c) => c.name === "No secrets in the hand-in")).toMatchObject({ ok: false });
    expect((await t.handIn({ ...good(tx(8)), note: "The payment key step worked." })).ok).toBe(true);
  });
});

describe("dry-run bounties", () => {
  it("open without a prize, only for their testers, and never show on the site", async () => {
    const t = setup({ list: [{ ...STOA, testers: [ACCOUNT(person.address)] }], balance: 0n, receipts: { [tx(1)]: gasless(agentKey.address) } });
    expect(await t.s.publicList()).toEqual([]);
    await expect(t.s.publicOne(STOA.id)).rejects.toThrow(/no bounty by that name/);
    await t.link(rival, rivalAgent);
    await expect(t.enter(rival, rivalAgent)).rejects.toThrow(/no bounty by that name/);
    await t.link();
    expect(await t.enter()).toMatchObject({ ok: true });
    expect((await t.handIn({ repo: REPO, tx: tx(1), result: "https://x.test/r" })).ok).toBe(true);
    expect((await t.s.lockList()).bounties).toEqual([]);
  });
});
