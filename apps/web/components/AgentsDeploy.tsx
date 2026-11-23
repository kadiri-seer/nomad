"use client";

import { useState } from "react";
import { encodeDeployData, isAddress, parseUnits, type Abi } from "viem";
import { addressUrl, txUrl } from "@/lib/agent";
import { AGENTS_ABI } from "@/lib/agents-contract";
import { AGENTS_BYTECODE } from "@/lib/agents-bytecode";
import { REWARD_SAFE, TOKEN_CA } from "@/lib/token";
import { connect, getWallet, send, waitFor, walletMessage } from "@/lib/wallet";
import { Notice } from "./ui";

const DEFAULTS = { owner: REWARD_SAFE, treasury: REWARD_SAFE, maxMintFee: "1000000", mintFee: "10000", mintBurnPct: "50", platformPct: "10", platformBurnPct: "50" };
const pctToBps = (v: string) => {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v.trim())) throw new Error(`${v} is not a percentage`);
  return BigInt(Math.round(Number(v) * 100));
};

/** Deploys NomadAgents from the connected wallet, with Nomad's Safe as owner and treasury. */
export function AgentsDeploy() {
  const [f, setF] = useState(DEFAULTS);
  const [status, setStatus] = useState<{ tone: "info" | "ok" | "bad" | "warn"; text: string; hash?: string; address?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof DEFAULTS) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function deploy() {
    const eth = getWallet();
    if (!eth) return setStatus({ tone: "warn", text: "No wallet found in this browser." });
    let args: unknown[];
    try {
      if (!isAddress(f.owner) || !isAddress(f.treasury)) throw new Error("The owner and treasury must be addresses.");
      const max = parseUnits(f.maxMintFee.trim(), 18);
      const fee = parseUnits(f.mintFee.trim(), 18);
      const burn = pctToBps(f.mintBurnPct);
      const platform = pctToBps(f.platformPct);
      const pburn = pctToBps(f.platformBurnPct);
      if (fee > max) throw new Error("The mint fee cannot be above the maximum.");
      if (burn > 10000n || pburn > 10000n) throw new Error("A burn share cannot be above 100%.");
      if (platform > 2000n) throw new Error("The platform share cannot be above 20%.");
      args = [TOKEN_CA, f.owner, f.treasury, max, fee, burn, platform, pburn];
    } catch (e) {
      return setStatus({ tone: "warn", text: (e as Error).message });
    }
    setBusy(true);
    try {
      const account = await connect(eth);
      const data = encodeDeployData({ abi: AGENTS_ABI as unknown as Abi, bytecode: AGENTS_BYTECODE, args });
      setStatus({ tone: "info", text: "Confirm the deployment in your wallet." });
      const hash = await send(eth, account, { data });
      setStatus({ tone: "info", text: "Waiting for confirmation…", hash });
      const r = await waitFor(eth, hash);
      setStatus({ tone: "ok", text: "Deployed. Next: verify it on the explorer, set NEXT_PUBLIC_AGENTS_CONTRACT to this address in Vercel and redeploy the site, then open minting from the Safe.", hash, address: r.contractAddress ?? undefined });
    } catch (e) {
      setStatus({ tone: "bad", text: walletMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof DEFAULTS, label: string, note?: string) => (
    <label>
      {label}
      <input className="input" type="text" value={f[k]} onChange={set(k)} />
      {note && (
        <span className="muted" style={{ fontWeight: 400, fontSize: "0.88rem" }}>
          {note}
        </span>
      )}
    </label>
  );

  return (
    <section className="panel">
      <div className="panel-body">
        <div className="mint-form">
          <p style={{ margin: 0 }}>
            $NOMAD: <span className="mono">{TOKEN_CA}</span>
          </p>
          {field("owner", "Owner", "Can change fees within the limits, open or close minting, change the treasury. Nomad's Safe.")}
          {field("treasury", "Treasury", "Receives the unburned part of fees.")}
          {field("maxMintFee", "Maximum mint fee, in $NOMAD", "Fixed for good: the fee can never be set above this.")}
          {field("mintFee", "Mint fee, in $NOMAD")}
          {field("mintBurnPct", "Share of the mint fee burned, %")}
          {field("platformPct", "Nomad's share of a copy's price, %", "At most 20, for good.")}
          {field("platformBurnPct", "Share of Nomad's share burned, %")}
          <div>
            <button type="button" className="btn" disabled={busy} onClick={deploy}>
              {busy ? "Working…" : "Deploy"}
            </button>
          </div>
          {status && (
            <Notice tone={status.tone}>
              {status.text}
              {status.address && (
                <>
                  {" "}
                  Contract:{" "}
                  <a className="mono" href={addressUrl(status.address)} target="_blank" rel="noopener noreferrer">
                    {status.address}
                  </a>
                  .
                </>
              )}
              {status.hash && (
                <>
                  {" "}
                  <a href={txUrl(status.hash)} target="_blank" rel="noopener noreferrer">
                    Transaction
                  </a>
                </>
              )}
            </Notice>
          )}
        </div>
      </div>
    </section>
  );
}
