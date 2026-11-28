"use client";

import { useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";
import { sendFromTreasury, treasuryWallet } from "@/components/account/treasury-wallet";
import { bullAgreementPage } from "@/lib/bounties/bull";

type Waiting = { id: string; title: string; prize: { amount: string; token: string }; winner: Address; lockedUntil?: number; agreement?: string };
type Plan = { winner: Address; feeWei: string; feeUsd: number | null; calls: { to: Address; data: Hex; value: string }[] };

const slot = (b: { id: string; winner: string }) => `${b.id}:${b.winner.toLowerCase()}`;
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const post = async (body: object) => {
  const r = await fetch("/api/bounties/lock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "That did not go through.");
  return j;
};

/** Records a lock, retrying while the chain catches up. A lock sent from this browser is never sent twice. */
async function record(bounty: string, winner: Address, tx: string) {
  for (let i = 0; ; i++) {
    try {
      await post({ bounty, winner, action: "record", tx });
      break;
    } catch (e) {
      if (i >= 4) throw new Error(`The prize was locked in ${tx.slice(0, 10)}..., but Nomad could not read it yet. Open this page again in a minute to record it.`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  try {
    localStorage.removeItem(`nomad-bull-escrow:${bounty}:${winner.toLowerCase()}`);
  } catch {
    /* nothing kept */
  }
}

export function LockPrize() {
  const [list, setList] = useState<Waiting[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; error?: boolean } | null>(null);

  const load = async () => {
    const r = await fetch("/api/bounties/lock", { cache: "no-store" });
    const j = await r.json();
    setList(r.ok ? j.bounties : []);
    if (!r.ok) setMsg({ id: "", text: j.error ?? "Could not load the bounties.", error: true });
  };
  useEffect(() => {
    load();
  }, []);

  const lock = async (b: Waiting) => {
    setBusy(slot(b));
    setMsg(null);
    try {
      const key = `nomad-bull-escrow:${b.id}:${b.winner.toLowerCase()}`;
      let sent: string | null = null;
      try {
        sent = localStorage.getItem(key);
      } catch {
        /* no storage */
      }
      if (sent && /^0x[0-9a-fA-F]{64}$/.test(sent)) {
        await record(b.id, b.winner, sent);
      } else {
        const plan = (await post({ bounty: b.id, winner: b.winner, action: "plan" })) as Plan;
        const fee = `${Number(formatEther(BigInt(plan.feeWei))).toFixed(6)} ETH${plan.feeUsd ? ` (about $${plan.feeUsd.toFixed(2)})` : ""}`;
        setMsg({ id: slot(b), text: `Approve two transactions in your wallet: ${b.prize.amount} ${b.prize.token} for Bull, then the lock, with Bull's fee of ${fee}.` });
        const wallet = await treasuryWallet();
        const tx = await sendFromTreasury(wallet, plan.calls.map((c) => ({ to: c.to, data: c.data, value: BigInt(c.value) })));
        try {
          localStorage.setItem(key, tx);
        } catch {
          /* recorded right away below */
        }
        await record(b.id, b.winner, tx);
      }
      setMsg({ id: slot(b), text: "Locked. Confirm and pay the winner from Bounty review on your account page." });
      await load();
    } catch (e) {
      setMsg({ id: slot(b), text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  if (!list) return <p className="muted">Loading...</p>;
  if (!list.length) return <p className="muted">No prize is waiting to be locked. Pick a winner in Bounty review first.</p>;
  return (
    <ul className="bounty-locks">
      {list.map((b) => (
        <li key={slot(b)} className="bounty-lock">
          <div className="bounty-lock-row">
            <strong>{b.title}</strong>
            <span>
              {b.prize.amount} {b.prize.token}
            </span>
          </div>
          <p className="muted">To the winner&apos;s account {short(b.winner)}</p>
          {b.lockedUntil ? (
            <p className="muted">
              Locked until {new Date(b.lockedUntil).toLocaleString()}.{" "}
              <a href={bullAgreementPage(b.agreement!)} target="_blank" rel="noopener noreferrer">
                Agreement {b.agreement}
              </a>
            </p>
          ) : (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => lock(b)}>
              {busy === slot(b) ? "Locking..." : "Lock prize with Bull"}
            </button>
          )}
          {msg?.id === slot(b) && <p className={msg.error ? "bounty-error" : "muted"}>{msg.text}</p>}
        </li>
      ))}
      {msg && msg.id === "" && <p className="bounty-error">{msg.text}</p>}
    </ul>
  );
}
