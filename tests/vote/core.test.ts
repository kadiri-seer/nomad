import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { formatAmount, percent, roundStatus, tally, voteMessage, type Holders, type Round } from "../../apps/web/lib/vote/core";
import { checkVote } from "../../apps/web/lib/vote/verify";
import { MemoryVoteStore, storeFromEnv, UpstashVoteStore, votesKey } from "../../apps/web/lib/vote/store";
import { fetchBlockscoutHolders, fetchTransferLogs, holdersFromBlockscoutItems, holdersFromTransferLogs, sumHolders, TRANSFER_TOPIC } from "../../apps/web/lib/vote/snapshot";
import { clearRoundCache, governanceSource, loadHolders, loadIndex, loadRound } from "../../apps/web/lib/vote/rounds";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const carol = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";

const NOW = new Date("2026-12-02T12:00:00Z");

function makeRound(over: Partial<Round> = {}): Round {
  return {
    id: 3,
    title: "Round 3: next integration",
    opensAt: "2026-12-01T00:00:00Z",
    closesAt: "2026-12-04T00:00:00Z",
    token: { address: "0x14c0a77e792f6c9818888630e95c50cf3b48c979", symbol: "$NOMAD", decimals: 18 },
    snapshot: { takenAt: "2026-12-01T00:00:00Z", source: "test", block: 1, holders: 3, totalWeight: "0" },
    options: [
      { id: "12", label: "Windsurf", issue: 12 },
      { id: "15", label: "Cline", issue: 15 },
      { id: "18", label: "Zed", issue: 18 }
    ],
    excluded: [SAFE],
    roundIssue: 30,
    result: null,
    ...over
  };
}

const E18 = 10n ** 18n;
const holders: Holders = {
  [alice.address.toLowerCase()]: (1000n * E18).toString(),
  [bob.address.toLowerCase()]: (250n * E18).toString(),
  [SAFE.toLowerCase()]: (9999n * E18).toString()
};

async function signed(account: typeof alice, round: Round, choice: string, address = account.address) {
  const option = round.options.find((o) => o.id === choice)!;
  const signature = await account.signMessage({ message: voteMessage(round, option, address) });
  return { round: round.id, choice, address, signature };
}

describe("vote message", () => {
  it("is fixed text that names the round, choice and wallet", () => {
    const r = makeRound();
    expect(voteMessage(r, r.options[0], alice.address)).toBe(
      ["Nomad vote", "Round: 3", "Choice: #12 Windsurf", `Wallet: ${alice.address.toLowerCase()}`, "Weight: $NOMAD held when the round opened"].join("\n")
    );
  });
});

describe("checkVote", () => {
  const round = makeRound();

  it("accepts a holder's signed vote and weights it from the snapshot", async () => {
    const r = await checkVote(round, holders, await signed(alice, round, "12"), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vote.address).toBe(alice.address.toLowerCase());
      expect(r.vote.weight).toBe((1000n * E18).toString());
      expect(r.vote.choice).toBe("12");
    }
  });

  it("rejects votes outside the round window", async () => {
    const input = await signed(alice, round, "12");
    expect(await checkVote(round, holders, input, new Date("2026-11-30T00:00:00Z"))).toMatchObject({ ok: false, status: 409 });
    expect(await checkVote(round, holders, input, new Date("2026-12-04T00:00:00Z"))).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects votes once a result is published, even before the closing time", async () => {
    const done = makeRound({ result: { finalizedAt: NOW.toISOString(), totals: {}, voters: {}, totalWeight: "0", voterCount: 0, winner: null, rejected: 0 } });
    expect(await checkVote(done, holders, await signed(alice, done, "12"), NOW)).toMatchObject({ ok: false, status: 409, error: "This round has closed." });
  });

  it("rejects a vote for another round", async () => {
    const input = { ...(await signed(alice, round, "12")), round: 2 };
    expect(await checkVote(round, holders, input, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects options that are not on the ballot", async () => {
    const input = { ...(await signed(alice, round, "12")), choice: "99" };
    expect(await checkVote(round, holders, input, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects wallets that held nothing when the round opened", async () => {
    expect(await checkVote(round, holders, await signed(carol, round, "12"), NOW)).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects the reward wallet and other excluded wallets", async () => {
    const r = makeRound({ excluded: [SAFE, alice.address] });
    expect(await checkVote(r, holders, await signed(alice, r, "12"), NOW)).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a signature made by a different wallet", async () => {
    const input = await signed(bob, round, "12", alice.address);
    expect(await checkVote(round, holders, input, NOW)).toMatchObject({ ok: false, error: "The signature does not match this wallet." });
  });

  it("rejects a signature moved to a different choice", async () => {
    const input = { ...(await signed(alice, round, "12")), choice: "15" };
    expect(await checkVote(round, holders, input, NOW)).toMatchObject({ ok: false, error: "The signature does not match this wallet." });
  });

  it("rejects malformed addresses and signatures", async () => {
    const good = await signed(alice, round, "12");
    expect(await checkVote(round, holders, { ...good, address: "0x123" }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await checkVote(round, holders, { ...good, signature: "0xdead" }, NOW)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("tally", () => {
  const round = makeRound();
  const A = alice.address.toLowerCase();
  const B = bob.address.toLowerCase();

  it("adds snapshot weights per option and picks the heaviest", () => {
    const t = tally(round, holders, [
      { address: A, choice: "15" },
      { address: B, choice: "12" }
    ]);
    expect(t.totals["15"]).toBe(1000n * E18);
    expect(t.totals["12"]).toBe(250n * E18);
    expect(t.voterCount).toBe(2);
    expect(t.winner).toBe("15");
  });

  it("counts a wallet once and ignores excluded and empty wallets", () => {
    const t = tally(round, holders, [
      { address: A, choice: "15" },
      { address: A, choice: "12" },
      { address: SAFE.toLowerCase(), choice: "12" },
      { address: carol.address.toLowerCase(), choice: "12" }
    ]);
    expect(t.voterCount).toBe(1);
    expect(t.totals["12"]).toBe(0n);
    expect(t.winner).toBe("15");
  });

  it("breaks ties by voter count, then by the older suggestion", () => {
    const even: Holders = { a: "", [A]: "100", [B]: "50", [carol.address.toLowerCase()]: "50" };
    const byVoters = tally(round, even, [
      { address: A, choice: "15" },
      { address: B, choice: "18" },
      { address: carol.address.toLowerCase(), choice: "18" }
    ]);
    expect(byVoters.winner).toBe("18");
    const flat: Holders = { [A]: "100", [B]: "100" };
    expect(tally(round, flat, [{ address: B, choice: "18" }, { address: A, choice: "15" }]).winner).toBe("15");
  });

  it("has no winner when nobody voted", () => {
    expect(tally(round, holders, []).winner).toBeNull();
  });
});

describe("helpers", () => {
  it("formats token amounts", () => {
    expect(formatAmount(1234567n * 10n ** 16n, 18)).toBe("12,345.67");
    expect(formatAmount("0", 18)).toBe("0");
    expect(formatAmount(5n * E18, 18)).toBe("5");
  });
  it("computes percentages of huge totals", () => {
    expect(percent(1n * E18 * 10n ** 9n, 3n * E18 * 10n ** 9n)).toBe(33.3);
    expect(percent(1n, 0n)).toBe(0);
  });
  it("knows the round status", () => {
    const r = makeRound();
    expect(roundStatus(r, new Date("2026-11-30T00:00:00Z"))).toBe("upcoming");
    expect(roundStatus(r, NOW)).toBe("open");
    expect(roundStatus(r, new Date("2026-12-05T00:00:00Z"))).toBe("closed");
  });
});

describe("vote storage", () => {
  const vote = { round: 3, address: alice.address.toLowerCase(), choice: "12", signature: "0x" + "1".repeat(130), weight: "1", votedAt: NOW.toISOString() };

  it("keeps one vote per wallet per round", async () => {
    const s = new MemoryVoteStore();
    expect(await s.addVote(vote)).toBe(true);
    expect(await s.addVote({ ...vote, choice: "15" })).toBe(false);
    expect((await s.getVote(3, alice.address))?.choice).toBe("12");
    expect(await s.listVotes(3)).toHaveLength(1);
    expect(await s.listVotes(4)).toHaveLength(0);
  });

  it("talks to Upstash with prefixed keys and only-if-new writes", async () => {
    const calls: unknown[] = [];
    const responses = [{ result: 1 }, { result: 0 }, { result: [vote.address, JSON.stringify(vote)] }];
    const fake = async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    };
    const s = new UpstashVoteStore("https://example.upstash.io", "t", fake);
    expect(await s.addVote(vote)).toBe(true);
    expect(await s.addVote(vote)).toBe(false);
    expect(await s.listVotes(3)).toEqual([vote]);
    expect(calls[0]).toEqual(["HSETNX", "nomad:vote:round:3", vote.address, JSON.stringify(vote)]);
    expect(votesKey(3).startsWith("nomad:")).toBe(true);
  });

  it("reports Upstash errors instead of pretending to save", async () => {
    const fake = async () => new Response(JSON.stringify({ error: "WRONGPASS" }), { status: 401 });
    await expect(new UpstashVoteStore("https://x", "t", fake).addVote(vote)).rejects.toThrow(/WRONGPASS/);
  });

  it("uses the connection Vercel's Upstash integration adds", () => {
    expect(storeFromEnv({})).toBeNull();
    expect(storeFromEnv({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" })).toBeInstanceOf(UpstashVoteStore);
    expect(storeFromEnv({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeInstanceOf(UpstashVoteStore);
  });
});

describe("balance snapshots", () => {
  const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const ZERO = "0x0000000000000000000000000000000000000000";
  const A = alice.address;
  const B = bob.address;
  const hexv = (n: bigint) => "0x" + n.toString(16);

  it("replays transfers, mints and burns", () => {
    const logs = [
      { topics: [TRANSFER_TOPIC, pad(ZERO), pad(A)], data: hexv(1000n) },
      { topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: hexv(300n) },
      { topics: [TRANSFER_TOPIC, pad(B), pad(ZERO)], data: hexv(100n) },
      { topics: ["0xother", pad(A), pad(B)], data: hexv(1n) }
    ];
    const h = holdersFromTransferLogs(logs);
    expect(h).toEqual({ [A.toLowerCase()]: "700", [B.toLowerCase()]: "200" });
    expect(sumHolders(h)).toBe(900n);
  });

  it("reads explorer holder pages, following next_page_params", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [{ address: { hash: A }, value: "500" }, { address: { hash: B }, value: "0" }], next_page_params: { items_count: 50, value: "500" } },
      "items_count=50&value=500": { items: [{ address: { hash: B }, value: "20" }, { address: "bad", value: "1" }], next_page_params: null }
    };
    const seen: string[] = [];
    const fake = async (url: string) => {
      const q = url.split("?")[1] ?? "";
      seen.push(q);
      return new Response(JSON.stringify(pages[q]), { status: 200 });
    };
    const h = await fetchBlockscoutHolders("https://explorer.example", "0xtoken", fake);
    expect(h).toEqual({ [A.toLowerCase()]: "500", [B.toLowerCase()]: "20" });
    expect(seen).toEqual(["", "items_count=50&value=500"]);
    expect(holdersFromBlockscoutItems([{ address: A, value: "7" }])).toEqual({ [A.toLowerCase()]: "7" });
  });

  it("fails loudly when the explorer refuses", async () => {
    const fake = async () => new Response("no", { status: 429 });
    await expect(fetchBlockscoutHolders("https://e", "0xt", fake)).rejects.toThrow(/429/);
  });

  it("shrinks the log range when the RPC refuses big ranges", async () => {
    let requests = 0;
    const fake = async (_u: string, init?: RequestInit) => {
      requests++;
      const { params } = JSON.parse(String(init?.body));
      const from = parseInt(params[0].fromBlock, 16);
      const to = parseInt(params[0].toBlock, 16);
      if (to - from + 1 > 1000) return new Response(JSON.stringify({ error: { message: "block range too large" } }), { status: 200 });
      const logs = [];
      for (let b = from; b <= to; b++) if (b % 250 === 0) logs.push({ topics: [TRANSFER_TOPIC, pad(ZERO), pad(A)], data: hexv(1n), blockNumber: hexv(BigInt(b)) });
      return new Response(JSON.stringify({ result: logs }), { status: 200 });
    };
    const logs = await fetchTransferLogs("https://rpc", "0xt", 0, 9999, fake);
    expect(logs).toHaveLength(40);
    expect(new Set(logs.map((l) => l.blockNumber)).size).toBe(40);
    expect(requests).toBeLessThan(60);
  });
});

describe("published rounds", () => {
  it("reads the index, round and snapshot from a folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nomad-gov-"));
    mkdirSync(join(dir, "rounds"));
    writeFileSync(join(dir, "rounds", "index.json"), JSON.stringify({ latest: 3 }));
    writeFileSync(join(dir, "rounds", "round-3.json"), JSON.stringify(makeRound()));
    writeFileSync(join(dir, "rounds", "round-3-holders.json"), JSON.stringify(holders));
    const src = governanceSource({ NOMAD_GOVERNANCE_SOURCE: dir });
    clearRoundCache();
    expect(await loadIndex(src)).toEqual({ latest: 3 });
    expect((await loadRound(3, src))?.title).toBe("Round 3: next integration");
    expect(await loadRound(4, src)).toBeNull();
    expect(await loadRound(0, src)).toBeNull();
    expect(Object.keys(await loadHolders(3, src))).toHaveLength(3);
    expect(governanceSource({}).kind).toBe("url");
  });
});
