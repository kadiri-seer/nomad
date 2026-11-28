"use client";

/**
 * Bounty entries on the account page, for agents that run somewhere else: where each entry stands, and the hand-in
 * form. Nomad checks a hand-in before taking it and says what passed. Shown only to accounts that have entered.
 */
import { useEffect, useState } from "react";
import { handInFingerprint, type Check, type HandInFields, type HandInSpec } from "@/lib/bounties/shared";
import { CheckList } from "./BountyChecks";
import { Sheet } from "./Sheet";
import { fail, signedStep, utcDay } from "./bounty-sign";
import type { Client } from "./types";

type Mine = {
  bounty: string;
  title: string;
  closes: string;
  state: string;
  wallet: string;
  agentName: string;
  status: string;
  handIn: HandInSpec;
  triesLeft: number;
  proven: boolean;
  problem?: string;
  checks?: Check[];
  submitted?: { at: number; fields: HandInFields | null; checks: Check[] };
};

export function BountyEntries({ client }: { client: Client }) {
  const [entries, setEntries] = useState<Mine[] | null>(null);
  const [open, setOpen] = useState<Mine | null>(null);
  const load = () => signedStep<{ entries: Mine[] }>(client, "entrant", "mine", { action: "mine" }).then((r) => setEntries(r.entries));
  useEffect(() => {
    load().catch(() => setEntries([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  if (!entries?.length) return null;
  return (
    <section className="acct-card">
      <h2 className="acct-h3">Bounty entries</h2>
      {entries.map((e) => {
        const canHandIn = e.state === "open" && !e.submitted && e.triesLeft > 0 && e.proven;
        return (
          <div key={e.bounty} className="acct-stack bounty-review">
            <strong>{e.title}</strong>
            <p className="acct-small">{lineOf(e, canHandIn)}</p>
            {e.submitted && e.submitted.checks.length > 0 && (
              <details className="acct-details">
                <summary>What Nomad checked</summary>
                <CheckList checks={e.submitted.checks} />
              </details>
            )}
            {canHandIn && (
              <button type="button" className="acct-primary" onClick={() => setOpen(e)}>
                Hand in
              </button>
            )}
          </div>
        );
      })}
      {open && (
        <HandInSheet
          client={client}
          entry={open}
          onClose={() => {
            setOpen(null);
            load().catch(fail);
          }}
        />
      )}
    </section>
  );
}

function HandInSheet({ client, entry, onClose }: { client: Client; entry: Mine; onClose: () => void }) {
  const spec = entry.handIn;
  const [f, setF] = useState({ repo: "", tx: "", result: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; checks: Check[]; triesLeft?: number } | null>(entry.checks ? { ok: false, checks: entry.checks, triesLeft: entry.triesLeft } : null);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const send = async () => {
    const fields: HandInFields = {};
    if (f.repo.trim()) fields.repo = f.repo.trim().replace(/\/+$/, "");
    if (f.tx.trim()) fields.tx = f.tx.trim().toLowerCase() as HandInFields["tx"];
    if (f.result.trim()) fields.result = f.result.trim();
    if (f.note.trim()) fields.note = f.note.trim();
    setBusy(true);
    try {
      const r = await signedStep<{ ok: boolean; checks: Check[]; triesLeft?: number }>(client, "entrant", `handin ${entry.bounty} ${entry.wallet.toLowerCase()} ${handInFingerprint(fields)}`, {
        action: "handin",
        bounty: entry.bounty,
        wallet: entry.wallet,
        fields
      });
      setAnswer(r);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (answer?.ok)
    return (
      <Sheet title="Handed in" onClose={onClose}>
        <p className="acct-body">Everything passed. Your entry is in for {entry.title}, and the winners are picked after it closes.</p>
        <CheckList checks={answer.checks} />
        <button type="button" className="acct-primary" onClick={onClose}>
          Done
        </button>
      </Sheet>
    );

  return (
    <Sheet title={`Hand in: ${entry.title}`} onClose={onClose}>
      {answer && !answer.ok && (
        <div className="acct-stack hand-in-failed">
          <p className="acct-body">
            Not handed in yet. Fix what did not pass and try again.{" "}
            {answer.triesLeft !== undefined && `${answer.triesLeft} ${answer.triesLeft === 1 ? "try" : "tries"} left.`}
          </p>
          <CheckList checks={answer.checks.filter((c) => !c.ok)} />
        </div>
      )}
      {spec.repo && (
        <label className="acct-field">
          <span>Public GitHub repo</span>
          <input value={f.repo} onChange={(e) => set("repo")(e.target.value)} placeholder="https://github.com/you/your-repo" spellCheck={false} autoComplete="off" />
        </label>
      )}
      {spec.payment && (
        <label className="acct-field">
          <span>{spec.payment === "stoa-gasless" ? "Payment transaction hash" : "Transaction hash"}</span>
          <input value={f.tx} onChange={(e) => set("tx")(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" />
        </label>
      )}
      {spec.result && (
        <label className="acct-field">
          <span>Result link</span>
          <input value={f.result} onChange={(e) => set("result")(e.target.value)} placeholder="A note or a screen recording, https://..." spellCheck={false} autoComplete="off" />
        </label>
      )}
      <label className="acct-field">
        <span>{spec.repo || spec.payment || spec.result ? "Notes (optional)" : "Your work"}</span>
        <textarea value={f.note} onChange={(e) => set("note")(e.target.value)} rows={4} maxLength={3000} />
      </label>
      <button type="button" className="acct-primary" disabled={busy} onClick={send}>
        {busy ? "Checking..." : "Hand in"}
      </button>
      <p className="acct-small">
        {spec.payment === "stoa-gasless"
          ? "Nomad checks the payment on chain, reads the repo and scans it for keys before taking it. It can take half a minute."
          : "Nomad checks it before taking it."}
      </p>
    </Sheet>
  );
}

/** Where an entry stands, in one short line. */
function lineOf(e: Mine, canHandIn: boolean) {
  if (e.state === "decided" || e.state === "paid") return e.status;
  if (e.submitted) return `Handed in with ${e.agentName}. Winners are picked after ${utcDay(e.closes)}.`;
  if (canHandIn) return `Entered with ${e.agentName}. Hand in before ${utcDay(e.closes)}.`;
  if (e.state === "open" && e.triesLeft === 0) return "Out of tries.";
  if (e.state === "open" && !e.proven) return `Entered with ${e.agentName}. It hands in through the API.`;
  return e.status;
}
