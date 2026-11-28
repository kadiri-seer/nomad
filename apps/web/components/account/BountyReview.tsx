"use client";

/**
 * Bounty review on the account page, shown only to reviewers. Nomad's team approves sponsors' bounties and pays every
 * prize; a bounty's sponsor reads the work handed in to its own bounties and picks the winners. Paying goes through
 * Bull's escrow: the treasury's wallet locks a winner's prize (on /bounties/lock, in the wallet's own browser), and the
 * team's Nomad account confirms, which releases it. Nomad checks each step on chain, and every step is signed by the
 * reviewer's sign-in wallet.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { send } from "@/lib/accounts/client";
import { bullAgreementPage, confirmAndReleaseCalls } from "@/lib/bounties/bull";
import { BOUNTY_DAYS, noteFingerprint, placesOf, PROOF_LABEL, type Award, type Bounty, type BountyResult, type Entry, type StoredBounty } from "@/lib/bounties/shared";
import { CopyButton } from "../CopyButton";
import { Sheet } from "./Sheet";
import { daysOf, fail, scheduleLine, short, signedStep } from "./bounty-sign";
import type { Client } from "./types";

type Reviewed = Bounty & { state: string; result: BountyResult | null; entries: Entry[]; team: boolean; arbiter?: boolean };
type Approved = StoredBounty & { state: string; entries: number; halfIn: boolean; showing: boolean; wholePrize: string };
const LOCK_PAGE = "https://www.thenomad.website/bounties/lock";
const lc = (a: string) => a.toLowerCase();

export function BountyReview({ client }: { client: Client }) {
  const [who, setWho] = useState<{ reviewer: boolean; team: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  // The sign-in wallet proves who it is (silently, no prompt); the server answers only about that wallet.
  useEffect(() => {
    signedStep<{ reviewer: boolean; team: boolean }>(client, "review", "check", { action: "check" })
      .then(setWho)
      .catch(() => undefined);
  }, [client]);
  if (!who?.reviewer) return null;
  return (
    <section className="acct-card">
      <h2 className="acct-h3">Bounty review</h2>
      <p className="acct-body">{who.team ? "Approve new bounties, pick winners and pay them through Bull." : "Read the work handed in to your bounties and pick the winners."}</p>
      <button type="button" className="acct-secondary" onClick={() => setOpen(true)}>
        Open review
      </button>
      {open && <ReviewSheet client={client} team={who.team} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ReviewSheet({ client, team, onClose }: { client: Client; team: boolean; onClose: () => void }) {
  const [list, setList] = useState<Reviewed[] | null>(null);
  const [pending, setPending] = useState<StoredBounty[]>([]);
  const [approved, setApproved] = useState<Approved[]>([]);
  const [busy, setBusy] = useState(false);

  const step = <T,>(label: string, body: Record<string, unknown>) => signedStep<T>(client, "review", label, body);
  const refresh = async () => {
    setList((await step<{ bounties: Reviewed[] }>("list", { action: "list" })).bounties);
    if (team) {
      const p = await step<{ bounties: StoredBounty[]; approved?: Approved[] }>("pending", { action: "pending" });
      setPending(p.bounties);
      setApproved(p.approved ?? []);
    }
  };
  useEffect(() => {
    refresh().catch((e) => {
      fail(e);
      onClose();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** The team's Nomad account confirms, which releases the prize to the winner in the same operation. */
  const payOut = (b: Reviewed, a: Award) =>
    act(async () => {
      const { txHash } = await send(client, confirmAndReleaseCalls(a.escrow!.id));
      await step(`paid ${b.id} ${lc(a.winner)} ${lc(txHash)}`, { action: "paid", bounty: b.id, winner: a.winner, tx: txHash });
    });
  const pick = (b: Reviewed, winner: Address) => act(() => step(`pick ${b.id} ${lc(winner)}`, { action: "pick", bounty: b.id, winner }));
  const unpick = (b: Reviewed, winner: Address) => act(() => step(`unpick ${b.id} ${lc(winner)}`, { action: "unpick", bounty: b.id, winner }));

  return (
    <Sheet title="Bounty review" onClose={onClose}>
      {!list && <p className="acct-small">Loading...</p>}

      {pending.length > 0 && <h3 className="acct-h3">Waiting for approval</h3>}
      {pending.map((b) => (
        <Approval key={b.id} b={b} busy={busy} act={act} step={step} />
      ))}

      {approved.length > 0 && <h3 className="acct-h3">Approved</h3>}
      {approved.map((b) => (
        <div key={b.id} className="acct-stack bounty-review">
          <div className="acct-between">
            <strong>{b.title}</strong>
            <span className="acct-small">
              {b.prize.amount} USDG x {placesOf(b)}
            </span>
          </div>
          <p className="acct-small">
            With {b.sponsor?.name ?? "a sponsor"}. {scheduleLine(b.opens, daysOf(b))}.
          </p>
          <p className="acct-small">{approvedLine(b)}</p>
          {b.showing && (
            <a className="acct-small" href={`/bounties/${b.id}`}>
              See its page
            </a>
          )}
        </div>
      ))}

      {list && list.length === 0 && pending.length === 0 && approved.length === 0 && <p className="acct-body">No bounty is waiting for a decision.</p>}
      {list && list.length > 0 && (pending.length > 0 || approved.length > 0) && <h3 className="acct-h3">Winners</h3>}
      {list?.map((b) => {
        const awards = b.result?.awards ?? [];
        const places = placesOf(b);
        const left = places - awards.length;
        const picked = new Set(awards.map((a) => lc(a.winner)));
        const rest = b.entries.filter((e) => !picked.has(lc(e.owner)));
        return (
          <div key={b.id} className="acct-stack bounty-review">
            <div className="acct-between">
              <strong>{b.title}</strong>
              <span className="acct-small">
                {b.prize.amount} {b.prize.token}
                {places > 1 ? ` x ${places}` : ""}
              </span>
            </div>
            {b.sponsor && <p className="acct-small">Co-sponsored by {b.sponsor.name}</p>}

            {awards.map((a) => (
              <AwardRow key={a.winner} a={a} entry={b.entries.find((e) => lc(e.owner) === lc(a.winner))} team={team} arbiter={!!b.arbiter} busy={busy} onPay={() => payOut(b, a)} onUnpick={() => unpick(b, a.winner)} />
            ))}

            {left > 0 && rest.length === 0 && <p className="acct-small">{awards.length ? "No other work was handed in." : "Nothing was handed in."}</p>}
            {left > 0 && rest.length > 0 && (
              <p className="acct-small">
                {left} {left === 1 ? "place" : "places"} left to pick from {rest.length} {rest.length === 1 ? "entry" : "entries"}.
              </p>
            )}
            {left > 0 &&
              rest.map((e) => (
                <details key={e.owner} className="bounty-entry">
                  <summary>
                    <span>{e.agentName}</span>
                    <span className="acct-small">{PROOF_LABEL[e.submission!.proof]}</span>
                  </summary>
                  <p className="bounty-work">{e.submission!.text}</p>
                  {e.submission!.record && <p className="acct-small">Used: {[...new Set(e.submission!.record.calls.filter((c) => c.ok).map((c) => c.service))].join(", ") || "no outside services"}</p>}
                  <button type="button" className="acct-secondary" disabled={busy} onClick={() => pick(b, e.owner)}>
                    Pick as winner
                  </button>
                </details>
              ))}
          </div>
        );
      })}
    </Sheet>
  );
}

function AwardRow({ a, entry, team, arbiter, busy, onPay, onUnpick }: { a: Award; entry?: Entry; team: boolean; arbiter: boolean; busy: boolean; onPay: () => void; onUnpick: () => void }) {
  const escrow = a.escrow && a.escrow.expiresAt > Date.now() ? a.escrow : null;
  return (
    <div className="acct-stack">
      <p className="acct-body">
        Winner: <strong>{entry?.agentName ?? short(a.winner)}</strong>, {a.paidTx ? "paid" : "to be paid"} to {short(a.winner)}.
      </p>
      {!a.paidTx && !escrow && (
        <>
          {team ? (
            <>
              <p className="acct-small">Next, lock the prize with Bull from the treasury: open this page in Trust Wallet&apos;s browser and tap Lock prize with Bull. Then come back here to confirm.</p>
              <div className="acct-between">
                <code className="acct-address">{LOCK_PAGE}</code>
                <CopyButton text={LOCK_PAGE} className="acct-quiet" />
              </div>
            </>
          ) : (
            <p className="acct-small">Nomad locks the prize with Bull and pays it.</p>
          )}
          <button type="button" className="acct-quiet" disabled={busy} onClick={onUnpick}>
            Undo this pick
          </button>
        </>
      )}
      {!a.paidTx && escrow && (
        <>
          <p className="acct-small">
            Locked with Bull until {new Date(escrow.expiresAt).toLocaleString()}.{" "}
            <a href={bullAgreementPage(escrow.id)} target="_blank" rel="noopener noreferrer">
              Agreement {escrow.id}
            </a>
          </p>
          {arbiter ? (
            <>
              <button type="button" className="acct-primary" disabled={busy} onClick={onPay}>
                Confirm and pay this winner
              </button>
              <p className="acct-small">Sent from your Nomad account, paid from its credits. Nomad checks the payment on chain before marking it paid.</p>
            </>
          ) : (
            team && <p className="acct-small">The account named in Bull&apos;s agreement confirms and pays it.</p>
          )}
        </>
      )}
      {team && (
        <div className="acct-between">
          <code className="acct-address">{a.winner}</code>
          <CopyButton text={a.winner} className="acct-quiet" />
        </div>
      )}
    </div>
  );
}

/** One sponsor's bounty waiting for the team: the schedule, then approve or send back. Each side puts in half. */
function Approval({ b, busy, act, step }: { b: StoredBounty; busy: boolean; act: (f: () => Promise<unknown>) => void; step: <T>(label: string, body: Record<string, unknown>) => Promise<T> }) {
  const places = placesOf(b);
  const [date, setDate] = useState(b.opens.slice(0, 10));
  const [time, setTime] = useState(b.opens.slice(11, 16));
  const [days, setDays] = useState(String(daysOf(b)));
  const [locked, setLocked] = useState(!!b.scheduleLocked);
  const [note, setNote] = useState("");
  const dayChoices = BOUNTY_DAYS.includes(Number(days) as (typeof BOUNTY_DAYS)[number]) ? BOUNTY_DAYS : [...BOUNTY_DAYS, Number(days)].sort((x, y) => x - y);

  const approve = () =>
    act(() => {
      const opens = `${date}T${time}:00.000Z`;
      return step(`approve ${b.id} ${opens} ${Number(days)} ${locked ? 1 : 0}`, { action: "approve", bounty: b.id, opens, days: Number(days), locked });
    });
  const sendBack = () =>
    act(() => {
      const n = note.trim().slice(0, 500);
      return step(`return ${b.id} ${noteFingerprint(n)}`, { action: "return", bounty: b.id, note: n });
    });

  return (
    <div className="acct-stack bounty-review">
      <div className="acct-between">
        <strong>{b.title}</strong>
        <span className="acct-small">
          {b.prize.amount} USDG{places > 1 ? ` x ${places}` : ""}
        </span>
      </div>
      <p className="acct-small">
        From {b.sponsor?.name ?? "a sponsor"}. {places} winners, {b.prize.amount} USDG each: {b.sponsor?.share ?? "0"} USDG from them, {b.nomadShare ?? "0"} from Nomad. Asked for {scheduleLine(b.opens, daysOf(b))}.
      </p>
      <details className="bounty-entry">
        <summary>
          <span>Read the bounty</span>
          <span className="acct-small">{b.title}</span>
        </summary>
        <p className="bounty-work">{b.brief}</p>
        <p className="acct-small">Hand in: {b.result}</p>
      </details>
      <div className="acct-grid2">
        <label className="acct-field">
          <span>Opens (UTC date)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="acct-field">
          <span>Time (UTC)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="acct-field">
          <span>Runs for</span>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            {dayChoices.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="acct-confirm">
        <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
        <span>Lock the schedule so the sponsor cannot change it.</span>
      </label>
      <button type="button" className="acct-primary" disabled={busy} onClick={approve}>
        Approve
      </button>
      <label className="acct-field">
        <span>Or send it back with a note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
      </label>
      <button type="button" className="acct-secondary" disabled={busy || !note.trim()} onClick={sendBack}>
        Send back
      </button>
    </div>
  );
}

/** Where an approved bounty stands, in one line. */
function approvedLine(b: Approved) {
  if (!b.halfIn) return `Waiting for ${b.sponsor?.name ?? "the sponsor"}'s ${b.sponsor?.share ?? ""} USDG. Not on the site yet.`;
  if (!b.showing) return `${b.sponsor?.name ?? "The sponsor"}'s half is in. Not on the site yet: the treasury needs to hold the whole ${b.wholePrize} USDG, with Nomad's ${b.nomadShare ?? ""}.`;
  if (b.state === "upcoming") return "Funded. It shows as upcoming and opens on its start date.";
  if (b.state === "open") return `Open, ${b.entries} ${b.entries === 1 ? "entry" : "entries"} so far.`;
  if (b.state === "judging") return "Closed. Pick the winners below.";
  return "Winners picked. Lock and pay them below.";
}
