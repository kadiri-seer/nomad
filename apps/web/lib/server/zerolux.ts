/**
 * Zero Lux, as the agent runner uses it: agents on Robinhood Chain that sell one job per run for USDG, paid over x402
 * with a gasless EIP-3009 signature (zerolux.fun/skill.md and its open source, read Nov 27, 2026).
 *
 * Nomad hires only version 4 agents: they take the receive form of the payment (ReceiveWithAuthorization), which only
 * the agent's own wallet can submit, and refund a run that cannot be delivered. Before signing, every field of the
 * terms is checked against the agent's listing, and the wallet is checked on chain with its factory's isAgentWallet.
 * The payment comes from Nomad's small x402 wallet; the runner takes the price from the creator's credits first.
 */
import { getAddress, isAddress, parseAbi, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { USDG } from "../accounts/chain";

export const ZEROLUX = "https://zerolux.fun";
/** Version 4 and later: refundable, receive-form payments only. */
export const MIN_HIRE_VERSION = 4;
/** How long one hire waits for its answer inside a run; a slower one is collected on the agent's next run. */
export const HIRE_WAIT_MS = 90_000;
export const MAX_HIRE_INPUT = 4000;
/**
 * Zero Lux's own agent factories, by version, as deployed on Robinhood Chain (read Nov 27, 2026). A wallet is hired only
 * if the factory Zero Lux names is this one and it says the wallet is its own, so a changed answer from Zero Lux's
 * API cannot vouch for a wallet of its own choosing. A new version is hired once its factory is added here.
 */
export const ZEROLUX_FACTORIES: Record<number, Address> = { 4: "0xe645344552bd46BF170D55819850612D22349c0A" };

export type ZeroLuxAgent = { id: number; name: string; tagline: string; price: bigint; version: number; wallet: Address; runs: number; model: string | null; tools: string[] };
export type HireResult =
  | { status: "done"; output: string; run: string | null; tx: Hex | null; paid: bigint }
  | { status: "pending"; ticket: string; paid: bigint }
  /** `paid` is false when no money moved (the terms were refused, or Zero Lux said nothing was charged). */
  | { status: "failed"; reason: string; paid: boolean };

type Fetch = typeof fetch;
const FACTORY_ABI = parseAbi(["function isAgentWallet(address) view returns (bool)"]);
const USDG_DOMAIN = { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG } as const;
const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;
const lc = (a: string) => a.toLowerCase();
const plain = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

export class ZeroLuxError extends Error {}

/** One agent from Zero Lux's list, or null when it is not one Nomad hires (not live, too old, or malformed). */
export function readAgent(a: Record<string, unknown>): ZeroLuxAgent | null {
  const id = Number(a.id);
  const version = Number(a.version);
  if (!Number.isInteger(id) || id < 0 || a.status !== "live" || !(version >= MIN_HIRE_VERSION)) return null;
  if (typeof a.wallet !== "string" || !isAddress(a.wallet, { strict: false }) || typeof a.price !== "string" || !/^\d{1,12}$/.test(a.price)) return null;
  return {
    id,
    name: plain(a.name, 80) || `Agent ${id}`,
    tagline: plain(a.tagline, 200),
    price: BigInt(a.price),
    version,
    wallet: getAddress(a.wallet),
    runs: Number(a.runs) || 0,
    model: plain(a.model, 40) || null,
    tools: Array.isArray(a.tools) ? a.tools.map((t) => plain(t, 30)).filter(Boolean).slice(0, 10) : []
  };
}

export function zerolux(payer: LocalAccount, deps: { fetchImpl?: Fetch; isAgentWallet: (factory: Address, wallet: Address) => Promise<boolean>; sleep?: (ms: number) => Promise<void>; now?: () => number; origin?: string }) {
  const f = deps.fetchImpl ?? fetch;
  const origin = deps.origin ?? ZEROLUX;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let factories: Record<string, string | null> | null = null;

  const getJson = async (path: string) => {
    const r = await f(`${origin}${path}`, { signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error" });
    if (!r.ok) throw new ZeroLuxError(`Zero Lux answered ${r.status}.`);
    return (await r.json()) as Record<string, unknown>;
  };
  const runAt = (id: number, input: string, payment?: string) =>
    f(`${origin}/a/${id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
      redirect: "error"
    });
  const read = async (r: Response) => ((await r.json().catch(() => ({}))) as Record<string, unknown>);

  /** Presents a signed payment until the run answers, fails for good, or the wait is over. */
  async function present(id: number, input: string, ticket: string, paid: bigint, waitMs: number): Promise<HireResult> {
    const until = now() + waitMs;
    for (;;) {
      let r: Response;
      try {
        r = await runAt(id, input, ticket);
      } catch {
        if (now() > until) return { status: "pending", ticket, paid };
        await sleep(5000);
        continue;
      }
      const j = await read(r);
      if (r.ok && typeof j.output === "string") {
        const tx = typeof j.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.tx) ? (j.tx as Hex) : null;
        return { status: "done", output: j.output.slice(0, 20_000), run: typeof j.run === "string" ? j.run.slice(0, 80) : j.run != null ? String(j.run).slice(0, 80) : null, tx, paid };
      }
      if (j.again !== true) {
        const reason = plain(j.error, 240) || `Zero Lux answered ${r.status}.`;
        // Zero Lux says so when no money moved.
        return { status: "failed", reason, paid: !/nothing was charged|no money moved/i.test(reason) };
      }
      if (now() > until) return { status: "pending", ticket, paid };
      await sleep(Math.min(15, Math.max(1, Number(r.headers.get("retry-after")) || 5)) * 1000);
    }
  }

  return {
    /** Live version 4 agents, most used first. */
    async agents(): Promise<ZeroLuxAgent[]> {
      const j = await getJson("/api/agents");
      const list = Array.isArray(j.agents) ? (j.agents as Record<string, unknown>[]) : [];
      return list
        .map(readAgent)
        .filter((a): a is ZeroLuxAgent => !!a)
        .sort((a, b) => b.runs - a.runs);
    },

    /**
     * Hires agent `agent` once for `input`, paying at most `maxPrice` (USDG units). Nothing is signed unless the terms
     * are exactly the listing's: the receive form, to the agent's wallet, for its price, in USDG on Robinhood Chain,
     * and the wallet is one of Zero Lux's factories' own.
     */
    async hire(agent: ZeroLuxAgent, input: string, maxPrice: bigint, waitMs = HIRE_WAIT_MS): Promise<HireResult> {
      const text = input.trim().slice(0, MAX_HIRE_INPUT);
      if (!text) return { status: "failed", reason: "There was nothing to ask.", paid: false };
      if (agent.price > maxPrice) return { status: "failed", reason: "Its price is above this agent's limit per hire.", paid: false };
      let terms: Record<string, unknown>;
      try {
        const r = await runAt(agent.id, text);
        terms = await read(r);
        if (r.status !== 402) return { status: "failed", reason: plain(terms.error, 200) || "It is not taking runs right now.", paid: false };
      } catch {
        return { status: "failed", reason: "Zero Lux did not answer.", paid: false };
      }
      const accept = (Array.isArray(terms.accepts) ? terms.accepts[0] : null) as Record<string, unknown> | null;
      const sign = terms.sign as { domain?: Record<string, unknown>; primaryType?: string; message?: Record<string, unknown> } | undefined;
      const d = sign?.domain ?? {};
      const ok =
        !!accept &&
        accept.scheme === "exact" &&
        accept.network === "eip155:4663" &&
        typeof accept.payTo === "string" &&
        lc(accept.payTo) === lc(agent.wallet) &&
        typeof accept.asset === "string" &&
        lc(accept.asset) === lc(USDG) &&
        String(accept.maxAmountRequired) === agent.price.toString() &&
        sign?.primaryType === "ReceiveWithAuthorization" &&
        d.name === USDG_DOMAIN.name &&
        String(d.version) === USDG_DOMAIN.version &&
        Number(d.chainId) === USDG_DOMAIN.chainId &&
        typeof d.verifyingContract === "string" &&
        lc(d.verifyingContract) === lc(USDG) &&
        typeof sign.message?.to === "string" &&
        lc(sign.message.to) === lc(agent.wallet) &&
        String(sign.message?.value) === agent.price.toString();
      if (!ok) return { status: "failed", reason: "Its payment terms did not match its listing, so nothing was paid.", paid: false };
      try {
        factories ??= ((await getJson("/api/config")).factoryByVersion ?? {}) as Record<string, string | null>;
        const factory = factories[String(agent.version)];
        const pinned = ZEROLUX_FACTORIES[agent.version];
        if (!factory || !pinned || !isAddress(factory, { strict: false }) || lc(factory) !== lc(pinned) || !(await deps.isAgentWallet(pinned, agent.wallet)))
          return { status: "failed", reason: "Its wallet is not one of Zero Lux's own, so nothing was paid.", paid: false };
      } catch {
        return { status: "failed", reason: "Its wallet could not be checked, so nothing was paid.", paid: false };
      }
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const authorization = { from: payer.address, to: agent.wallet, value: agent.price, validAfter: 0n, validBefore: BigInt(Math.floor(now() / 1000) + 600), nonce };
      const signature = await payer.signTypedData({ domain: USDG_DOMAIN, types: RECEIVE_TYPES, primaryType: "ReceiveWithAuthorization", message: authorization });
      const payload = {
        x402Version: 1,
        scheme: "exact",
        network: "eip155:4663",
        payload: { authorization: { ...authorization, value: authorization.value.toString(), validAfter: "0", validBefore: authorization.validBefore.toString() }, signature }
      };
      const ticket = Buffer.from(JSON.stringify(payload)).toString("base64");
      return present(agent.id, text, ticket, agent.price, waitMs);
    },

    /** Zero Lux's factory for each agent version, as its API names them (for the status check; reads only). */
    async factories(): Promise<Record<string, string | null>> {
      factories ??= ((await getJson("/api/config")).factoryByVersion ?? {}) as Record<string, string | null>;
      return factories;
    },

    /** Collects a hire that was still working when its run ended. */
    collect(id: number, input: string, ticket: string, paid: bigint, waitMs = 20_000): Promise<HireResult> {
      return present(id, input.trim().slice(0, MAX_HIRE_INPUT), ticket, paid, waitMs);
    }
  };
}
export type ZeroLux = ReturnType<typeof zerolux>;

export { FACTORY_ABI as ZEROLUX_FACTORY_ABI };
