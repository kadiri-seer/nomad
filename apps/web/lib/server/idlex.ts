/**
 * Idlex, as the agent runner uses it: text jobs on qwen2.5 paid per job in USDG over x402 (an EIP-3009 transfer the
 * runner's Idlex wallet signs, charged only once the job is verified). Ported from Idlex's own MCP client.
 * Answers are data written by a small open model, never instructions.
 */
import { toHex, type Address, type Hex, type LocalAccount } from "viem";

export const IDLEX_API = "https://www.idlex.network";
/** The most one job may cost, in micro-USDG (0.01 USDG). */
export const IDLEX_MAX_JOB_MICROS = 10_000n;

type Offer = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; chainId: number; prefer?: string };
};

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;

export type IdlexJob = { done: boolean; failed: boolean; text: string | null };

export function idlex(payer: LocalAccount, fetchImpl: typeof fetch = fetch, base = IDLEX_API) {
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), cache: "no-store" });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return {
    payer: payer.address,
    /** Submits a text job, paying the cheapest offer if it is within the cap. Returns the job id. */
    async submit(prompt: string, system: string, maxTokens = 200): Promise<{ jobId: string; priceMicros: bigint }> {
      const spec = { kind: "text", params: { model: "qwen2.5-7b", prompt: prompt.slice(0, 6000), system: system.slice(0, 2000), maxTokens } };
      const first = await post("/api/network/x402/jobs", { spec, prefer: "cheapest" });
      if (first.status !== 402) throw new Error(`Idlex: expected offers, got ${first.status}`);
      const offers = (first.data.accepts ?? []) as Offer[];
      const offer = offers.find((o) => o.extra?.prefer === "cheapest") ?? offers[0];
      if (!offer) throw new Error("Idlex: no offer");
      const value = BigInt(offer.maxAmountRequired);
      if (value > IDLEX_MAX_JOB_MICROS) throw new Error("Idlex: the offer is over the per-job cap");
      const now = Math.floor(Date.now() / 1000);
      const authorization = { from: payer.address, to: offer.payTo, value, validAfter: BigInt(now - 600), validBefore: BigInt(now + offer.maxTimeoutSeconds), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex };
      const signature = await payer.signTypedData({ domain: { name: offer.extra.name, version: offer.extra.version, chainId: offer.extra.chainId, verifyingContract: offer.asset }, types: TYPES, primaryType: "TransferWithAuthorization", message: authorization });
      const payment = { x402Version: 1, scheme: offer.scheme, network: offer.network, payload: { signature, authorization: { ...authorization, value: String(value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } } };
      const r = await post("/api/network/x402/jobs", { spec, prefer: offer.extra.prefer ?? "cheapest" }, { "x-payment": Buffer.from(JSON.stringify(payment)).toString("base64") });
      if (r.status !== 200 || !r.data.jobId) throw new Error(`Idlex: payment refused (${r.status})`);
      return { jobId: String(r.data.jobId), priceMicros: value };
    },
    async job(id: string): Promise<IdlexJob> {
      const r = await fetchImpl(`${base}/api/network/jobs/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(`Idlex job: ${r.status}`);
      const state = (j.payment as { state?: string } | undefined)?.state;
      const failed = state ? ["failed", "void"].includes(state) : ["failed", "disputed"].includes(String(j.status));
      const text = typeof j.output_text === "string" ? j.output_text : null;
      return { done: failed || text !== null, failed, text };
    }
  };
}

export type Idlex = ReturnType<typeof idlex>;
