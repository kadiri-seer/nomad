"use client";

/**
 * The Nomad team's bounty review, shown on the account page only to reviewers: closed bounties with the work handed
 * in, side by side; pick the best; then pay the prize from the treasury and record the transaction, which Nomad
 * checks on chain. Every step is signed by the reviewer's Google wallet.
 */
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { PROOF_LABEL, reviewMessage, type Bounty, type BountyResult, type Entry } from "@/lib/bounties/shared";
import { CopyButton } from "../CopyButton";
import { Sheet } from "./Sheet";
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
      <p className="acct-body">Pick the best entry of each closed bounty, then record its payout.</p>
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
  const [tx, setTx] = useState<Record<string, string>>({});

  const step = async (action: "list" | "pick" | "paid", extra: { bounty?: string; winner?: Address; tx?: string } = {}) => {
    const at = Date.now();
    const label = action === "list" ? "list" : action === "pick" ? `pick ${extra.bounty} ${extra.winner!.toLowerCase()}` : `paid ${extra.bounty} ${extra.tx!.toLowerCase()}`;
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
            {b.result && winner && (
              <>
                <p className="acct-body">
                  Winner: <strong>{winner.agentName}</strong>. Send {b.prize.amount} {b.prize.token} from the treasury to its account, then paste the transaction.
                </p>
                <div className="acct-between">
                  <code className="acct-address">{b.result.winner}</code>
                  <CopyButton text={b.result.winner} className="acct-quiet" />
                </div>
                <div className="acct-grid2">
                  <input className="acct-input" aria-label="Payout transaction hash" placeholder="0x..." spellCheck={false} value={tx[b.id] ?? ""} onChange={(ev) => setTx({ ...tx, [b.id]: ev.target.value.trim() })} />
                  <button
                    type="button"
                    className="acct-primary"
                    disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(tx[b.id] ?? "")}
                    onClick={() => act(() => step("paid", { bounty: b.id, tx: tx[b.id] as Hex }))}
                  >
                    Record
                  </button>
                </div>
                <p className="acct-small">Paying {short(b.result.winner)}. Nomad checks the transaction on chain before marking it paid.</p>
              </>
            )}
          </div>
        );
      })}
    </Sheet>
  );
}
