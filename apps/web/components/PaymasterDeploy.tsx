"use client";

import { useState } from "react";
import { encodeDeployData, encodeFunctionData, isAddress, numberToHex, parseEther, type Abi } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { addressUrl, txUrl } from "@/lib/agent";
import { ENTRY_POINT } from "@/lib/accounts/chain";
import { PAYMASTER_ABI, PAYMASTER_BYTECODE } from "@/lib/paymaster-contract";
import { REWARD_SAFE } from "@/lib/token";
import { connect, getWallet, send, waitFor, walletMessage } from "@/lib/wallet";
import { Notice } from "./ui";

type Status = { tone: "info" | "ok" | "bad" | "warn"; text: string; hash?: string; address?: string } | null;

/**
 * Deploys NomadPaymaster from the connected wallet (owner and treasury: Nomad's Safe) and funds its deposit. The signer
 * key can be made here: it is created in this browser, shown once and never sent anywhere.
 */
export function PaymasterDeploy() {
  const [signer, setSigner] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [owner, setOwner] = useState(REWARD_SAFE);
  const [treasury, setTreasury] = useState(REWARD_SAFE);
  const [maxCost, setMaxCost] = useState("0.0005");
  const [paymaster, setPaymaster] = useState("");
  const [amount, setAmount] = useState("0.005");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  function makeKey() {
    const k = generatePrivateKey();
    setKey(k);
    setSigner(privateKeyToAddress(k));
  }

  async function run(label: string, build: () => { to?: string; data: `0x${string}`; value?: `0x${string}` }, done: (address?: string) => string) {
    const eth = getWallet();
    if (!eth) return setStatus({ tone: "warn", text: "No wallet found in this browser." });
    let tx: ReturnType<typeof build>;
    try {
      tx = build();
    } catch (e) {
      return setStatus({ tone: "warn", text: (e as Error).message });
    }
    setBusy(true);
    try {
      const account = await connect(eth);
      setStatus({ tone: "info", text: `Confirm the ${label} in your wallet.` });
      const hash = await send(eth, account, tx);
      setStatus({ tone: "info", text: "Waiting for confirmation…", hash });
      const r = await waitFor(eth, hash);
      const address = r.contractAddress ?? undefined;
      if (address) setPaymaster(address);
      setStatus({ tone: "ok", text: done(address), hash, address });
    } catch (e) {
      setStatus({ tone: "bad", text: walletMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  const deploy = () =>
    run(
      "deployment",
      () => {
        if (!isAddress(signer)) throw new Error("Make a signer key first, or enter the signer's address.");
        if (!isAddress(owner) || !isAddress(treasury)) throw new Error("The owner and treasury must be addresses.");
        const max = parseEther(maxCost.trim());
        if (max <= 0n || max > parseEther("0.01")) throw new Error("Keep the ceiling per operation above 0 and at most 0.01 ETH.");
        return { data: encodeDeployData({ abi: PAYMASTER_ABI as unknown as Abi, bytecode: PAYMASTER_BYTECODE, args: [ENTRY_POINT, signer, treasury, max, owner] }) };
      },
      () => "Deployed. Next: fund its deposit below, then set NEXT_PUBLIC_NOMAD_PAYMASTER to this address in Vercel."
    );

  const fund = () =>
    run(
      "deposit",
      () => {
        if (!isAddress(paymaster)) throw new Error("Enter the paymaster's address.");
        const v = parseEther(amount.trim());
        if (v <= 0n || v > parseEther("0.05")) throw new Error("Deposit between 0 and 0.05 ETH at a time; keep it small.");
        return { to: paymaster, data: encodeFunctionData({ abi: PAYMASTER_ABI as unknown as Abi, functionName: "deposit" }), value: numberToHex(v) };
      },
      () => "Deposit added. It pays the network fees of Nomad accounts; only the Safe can withdraw it, to the treasury."
    );

  const input = (label: string, value: string, set: (v: string) => void, note?: string) => (
    <label>
      {label}
      <input className="input" type="text" value={value} onChange={(e) => set(e.target.value)} />
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
          <div>
            <p style={{ margin: "0 0 8px" }}>
              <strong>1. Signer key.</strong> The site signs each operation it pays for with this key.
            </p>
            {!key ? (
              <button type="button" className="btn btn-ghost" onClick={makeKey}>
                Make a signer key
              </button>
            ) : (
              <Notice tone="warn">
                Copy this key now into Vercel as <span className="mono">NOMAD_PAYMASTER_SIGNER_KEY</span> (mark it sensitive). It is shown once, kept nowhere
                else and never sent from this page. Do not paste it anywhere else.
                <code className="mono" style={{ display: "block", wordBreak: "break-all", margin: "8px 0" }}>{key}</code>
                <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(key)}>
                  Copy key
                </button>
              </Notice>
            )}
          </div>
          {input("Signer address", signer, setSigner, "Filled in when you make a key here.")}
          {input("Owner", owner, setOwner, "Can withdraw the deposit, to the treasury only. Nomad's Safe.")}
          {input("Treasury", treasury, setTreasury, "Where withdrawals go. Fixed for good.")}
          {input("Ceiling per operation, ETH", maxCost, setMaxCost, "Fixed for good. 0.0005 is about 100 times a typical trade's network fee today.")}
          <div>
            <button type="button" className="btn" disabled={busy} onClick={deploy}>
              {busy ? "Working…" : "2. Deploy the paymaster"}
            </button>
          </div>
          {input("Paymaster address", paymaster, setPaymaster, "Filled in after deploying.")}
          {input("Deposit, ETH", amount, setAmount, "0.005 ETH covers roughly 1,000 operations at today's fees.")}
          <div>
            <button type="button" className="btn" disabled={busy} onClick={fund}>
              {busy ? "Working…" : "3. Fund the deposit"}
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
