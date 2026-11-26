"use client";

/**
 * The Nomad team's bounty review, shown on the account page only to reviewers: closed bounties with the work handed
 * in, side by side; pick the best; then pay the prize through Bull's escrow: the treasury's wallet locks it for the
 * winner, and the reviewer's Nomad account confirms, which releases it. Nomad checks each step on chain. Every step
 * is signed by the reviewer's Google wallet.
 */
import { useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";
import { send } from "@/lib/accounts/client";
import { bullAgreementPage, confirmAndReleaseCalls } from "@/lib/bounties/bull";
import { PROOF_LABEL, reviewMessage, type Bounty, type BountyResult, type Entry } from "@/lib/bounties/shared";
import { CopyButton } from "../CopyButton";
import { Sheet } from "./Sheet";
import { sendFromTreasury, treasuryWallet } from "./treasury-wallet";
import type { Client } from "./types";

type Reviewed = Bounty & { state: string; result: BountyResult | null; entries: Entry[] };

const fail = (e: unknown) => window.dispatchEvent(new CustomEvent("nomad-account-error", { detail: (e as Error)?.message ?? "Something went wrong." }));
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export function BountyReview({ client }: { client: Client }) {
  const [reviewer, setReviewer] = useState(false);
  const [open, setOpen] = useState(false);
  // The sign-in wallet proves who it is (silently, no prompt); the server answers only about that wallet.
  useEffect(() => {
    (async () => {
      const at = Date.now();
      const signature = await client.owner.signMessage({ message: reviewMessage("check", at) });
      const r = await fetch("/api/bounties/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: client.signer, action: "check", at, signature }) });
      if (r.ok) setReviewer(!!(await r.json()).reviewer);
    })().catch(() => undefined);
  }, [client]);
  if (!reviewer) return null;
  return (
    <section className="acct-card">
      <h2 className="acct-h3">Bounty review</h2>
      <p className="acct-body">Pick the best entry of each closed bounty, then pay it through Bull.</p>
      <button type="button" className="acct-secondary" onClick={() => setOpen(true)}>
        Open review
      </button>
      {open && <ReviewSheet client={client} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ReviewSheet({ client, onClose }: { client: Client; onClose: () => void }) {
  const [list, setList] = useState<Reviewed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});

  const step = async (action: "list" | "pick" | "escrow-plan" | "escrow" | "paid", extra: { bounty?: string; winner?: Address; tx?: string } = {}) => {
    const at = Date.now();
    const label =
      action === "list"
        ? "list"
        : action === "pick"
          ? `pick ${extra.bounty} ${extra.winner!.toLowerCase()}`
          : action === "escrow-plan"
            ? `escrow-plan ${extra.bounty}`
            : `${action} ${extra.bounty} ${extra.tx!.toLowerCase()}`;
    const signature = await client.owner.signMessage({ message: reviewMessage(label, at) });
    const r = await fetch("/api/bounties/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: client.signer, action, ...extra, at, signature }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "That did not go through.");
    return j;
  };
  const load = async () => {
    setBusy(true);
    try {
      setList((await step("list")).bounties);
    } catch (e) {
      fail(e);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setList((await step("list")).bounties);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** Bull plans the escrow, Nomad checks it, and the treasury's wallet extension sends it. */
  const lock = (b: Reviewed) =>
    act(async () => {
      // A lock already sent from this browser but not yet recorded is recorded, never sent twice.
      const key = `nomad-bull-escrow:${b.id}`;
      const sent = (() => {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      })();
      const record = async (tx: string) => {
        for (let i = 0; ; i++) {
          try {
            await step("escrow", { bounty: b.id, tx });
            break;
          } catch (e) {
            if (i >= 4) throw new Error(`The prize was locked in ${tx.slice(0, 10)}..., but Nomad could not read it yet. Reopen the review in a minute to record it. ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 4000));
          }
        }
        try {
          localStorage.removeItem(key);
        } catch {
          /* nothing kept */
        }
        setNote({ ...note, [b.id]: "" });
      };
      if (sent && /^0x[0-9a-fA-F]{64}$/.test(sent)) return record(sent);
      const plan = (await step("escrow-plan", { bounty: b.id })) as { arbiter: Address; feeWei: string; feeUsd: number | null; calls: { to: Address; data: Hex; value: string }[] };
      if (plan.arbiter.toLowerCase() !== client.account.address.toLowerCase()) throw new Error("The escrow would wait on another account's confirmation. Sign in with your reviewer account.");
      const fee = `${Number(formatEther(BigInt(plan.feeWei))).toFixed(6)} ETH${plan.feeUsd ? ` (about $${plan.feeUsd.toFixed(2)})` : ""}`;
      setNote({ ...note, [b.id]: `Confirm two transactions in the treasury's wallet: approving ${b.prize.amount} ${b.prize.token} for Bull, then locking it, with Bull's fee of ${fee}.` });
      const wallet = await treasuryWallet();
      const tx = await sendFromTreasury(wallet, plan.calls.map((c) => ({ to: c.to, data: c.data, value: BigInt(c.value) })));
      try {
        localStorage.setItem(key, tx);
      } catch {
        /* recorded right away below */
      }
      await record(tx);
    });

  /** The reviewer's Nomad account confirms, which releases the prize to the winner in the same operation. */
  const release = (b: Reviewed) =>
    act(async () => {
      const { txHash } = await send(client, confirmAndReleaseCalls(b.result!.escrow!.id));
      await step("paid", { bounty: b.id, tx: txHash });
    });

  return (
    <Sheet title="Bounty review" onClose={onClose}>
      {!list && <p className="acct-small">Loading...</p>}
      {list && list.length === 0 && <p className="acct-body">No bounty is waiting for a decision.</p>}
      {list?.map((b) => {
        const winner = b.result ? b.entries.find((e) => e.owner.toLowerCase() === b.result!.winner.toLowerCase()) : null;
        return (
          <div key={b.id} className="acct-stack bounty-review">
            <div className="acct-between">
              <strong>{b.title}</strong>
              <span className="acct-small">
                {b.prize.amount} {b.prize.token}
              </span>
            </div>
            {!b.result && b.entries.length === 0 && <p className="acct-small">Nothing was handed in.</p>}
            {!b.result &&
              b.entries.map((e) => (
                <details key={e.owner} className="bounty-entry">
                  <summary>
                    <span>{e.agentName}</span>
                    <span className="acct-small">{PROOF_LABEL[e.submission!.proof]}</span>
                  </summary>
                  <p className="bounty-work">{e.submission!.text}</p>
                  {e.submission!.record && <p className="acct-small">Used: {[...new Set(e.submission!.record.calls.filter((c) => c.ok).map((c) => c.service))].join(", ") || "no outside services"}</p>}
                  <button type="button" className="acct-secondary" disabled={busy} onClick={() => act(() => step("pick", { bounty: b.id, winner: e.owner }))}>
                    Pick as winner
                  </button>
                </details>
              ))}
            {b.result && winner && (() => {
              const escrow = b.result.escrow && b.result.escrow.expiresAt > Date.now() ? b.result.escrow : null;
              return (
                <>
                  <p className="acct-body">
                    Winner: <strong>{winner.agentName}</strong>, paid to {short(b.result.winner)}.
                  </p>
                  {!escrow && (
                    <>
                      <p className="acct-small">
                        Lock the prize with Bull from the treasury&apos;s wallet extension in this browser. It pays {short(b.result.winner)} once you confirm here, and goes back to the treasury if you do not confirm within 3 days.
                      </p>
                      <button type="button" className="acct-primary" disabled={busy} onClick={() => lock(b)}>
                        Lock prize with Bull
                      </button>
                      {note[b.id] && <p className="acct-small">{note[b.id]}</p>}
                    </>
                  )}
                  {escrow && (
                    <>
                      <p className="acct-small">
                        Locked with Bull until {new Date(escrow.expiresAt).toLocaleString()}.{" "}
                        <a href={bullAgreementPage(escrow.id)} target="_blank" rel="noopener noreferrer">
                          Agreement {escrow.id}
                        </a>
                      </p>
                      <button type="button" className="acct-primary" disabled={busy} onClick={() => release(b)}>
                        Confirm and pay the winner
                      </button>
                      <p className="acct-small">Sent from your Nomad account, paid from its credits. Nomad checks the payment on chain before marking the bounty paid.</p>
                    </>
                  )}
                  <div className="acct-between">
                    <code className="acct-address">{b.result.winner}</code>
                    <CopyButton text={b.result.winner} className="acct-quiet" />
                  </div>
                </>
              );
            })()}
          </div>
        );
      })}
    </Sheet>
  );
}
