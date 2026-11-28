"use client";

/**
 * A whitelisted sponsor's bounties, shown on the account page only to sponsors. The sponsor writes a bounty and sends
 * it to Nomad; Nomad approves it (keeping or setting the schedule); the sponsor then funds its half of the prize from
 * this Nomad account to the treasury. Its entries and winners are picked from Bounty review. Every step is signed by the
 * sponsor's sign-in wallet.
 */
import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { TREASURY } from "@/lib/accounts/chain";
import { topUpUsdgCalls } from "@/lib/accounts/client";
import { BOUNTY_DAYS, draftFingerprint, normalDraft, SPONSOR_MAX_PLACES, SPONSOR_MIN_PLACES, sponsorSplit, usdgText, type StoredBounty } from "@/lib/bounties/shared";
import { CopyButton } from "../CopyButton";
import { Sheet } from "./Sheet";
import { daysOf, fail, scheduleLine, short, signedStep } from "./bounty-sign";
import type { Client, Confirm } from "./types";

type Mine = StoredBounty & { state: string | null; entries: number; awards: number };
const keyOf = (b: { id: string }) => `nomad-sponsor-deposit:${b.id}`;

type Me = { sponsor: { name: string; account: string; preset: { opens: string; days: number } | null; prize: string } | null; bounties?: Mine[] };

/** What a sponsor's bounty is doing, in a few words. */
function statusLine(b: Mine) {
  if (b.status === "waiting") return "Waiting for Nomad's approval";
  if (b.status === "returned") return "Sent back for changes";
  if (b.sponsor && Number(b.sponsor.share) > 0 && !b.deposit) return "Approved. Fund your half to open it";
  if (b.state === "upcoming") return `Opens ${scheduleLine(b.opens, daysOf(b))}`;
  if (b.state === "open") return `Open, ${b.entries} ${b.entries === 1 ? "entry" : "entries"}`;
  if (b.state === "judging") return "Closed. Pick the winners in Bounty review";
  if (b.state === "decided") return "Winners picked";
  return "Paid";
}

export function BountySponsor({ client, onConfirm }: { client: Client; onConfirm: (c: Confirm) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState<Mine | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => signedStep<Me>(client, "sponsor", "check", { action: "check" }).then(setMe);
  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  if (!me?.sponsor) return null;
  const sponsor = me.sponsor;

  const cancel = async (b: Mine) => {
    setBusy(true);
    try {
      const r = await signedStep<{ refund: string | null }>(client, "sponsor", `cancel ${b.id}`, { action: "cancel", bounty: b.id });
      setNotice(r.refund ?? "Cancelled.");
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** Records a sent half, retrying while the chain catches up. A half sent from this browser is never sent twice. */
  const record = async (b: Mine, txHash: string) => {
    for (let i = 0; ; i++) {
      try {
        await signedStep(client, "sponsor", `deposit ${b.id} ${txHash.toLowerCase()}`, { action: "deposit", bounty: b.id, tx: txHash });
        break;
      } catch (e) {
        if (i >= 4) throw new Error(`Sent in ${txHash.slice(0, 10)}..., but Nomad could not read it yet. Tap Fund your half again in a minute to record it. Nothing is sent twice.`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    try {
      localStorage.removeItem(keyOf(b));
    } catch {
      /* nothing kept */
    }
    await load();
  };
  const recordSent = async (b: Mine, txHash: string) => {
    setBusy(true);
    try {
      await record(b, txHash);
      setNotice("Your half is in. The bounty opens on its start date.");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const fund = (b: Mine) => {
    let sent: string | null = null;
    try {
      sent = localStorage.getItem(keyOf(b));
    } catch {
      /* no storage */
    }
    if (sent && /^0x[0-9a-fA-F]{64}$/.test(sent)) return recordSent(b, sent);
    onConfirm({
      title: "Fund your half",
      amount: `${b.sponsor!.share} USDG`,
      amountNote: `Your half of ${b.title}`,
      rows: [
        ["To", "Nomad's treasury"],
        ["Winners", `${b.places ?? 1}, ${b.prize.amount} USDG each`],
        ["Nomad puts in", `${b.nomadShare ?? "0"} USDG`]
      ],
      note: "Nomad holds the prize in its treasury until the winners are paid. If the bounty is cancelled before it opens, your half is sent back.",
      build: async () => topUpUsdgCalls(parseUnits(b.sponsor!.share, 6)),
      after: async (txHash) => {
        try {
          localStorage.setItem(keyOf(b), txHash);
        } catch {
          /* recorded right away below */
        }
        try {
          await record(b, txHash);
        } catch (e) {
          return (e as Error).message;
        }
      },
      done: { title: "Half funded", body: "Your bounty opens on its start date." }
    });
  };

  return (
    <section className="acct-card">
      <h2 className="acct-h3">Your bounties</h2>
      <p className="acct-body">
        Post a bounty as {sponsor.name}: a {sponsor.prize} USDG prize shared by the winners, half from you and half from Nomad. Nomad approves it before it shows, and you fund your half from this account.
      </p>
      {(me.bounties ?? []).map((b) => (
        <div key={b.id} className="acct-stack bounty-review">
          <div className="acct-between">
            <strong>{b.title}</strong>
            <span className="acct-small">
              {b.prize.amount} USDG{(b.places ?? 1) > 1 ? ` x ${b.places}` : ""}
            </span>
          </div>
          <p className="acct-small">{statusLine(b)}</p>
          {b.status === "returned" && b.note && <p className="acct-body">Nomad: {b.note}</p>}
          <div className="bounty-actions">
            {b.status === "approved" && b.sponsor && Number(b.sponsor.share) > 0 && !b.deposit && (
              <button type="button" className="acct-primary" disabled={busy} onClick={() => fund(b)}>
                Fund your half
              </button>
            )}
            {b.status === "approved" && b.sponsor && Number(b.sponsor.share) > 0 && !b.deposit && b.sponsor.account.toLowerCase() !== client.account.address.toLowerCase() && (
              <OtherWallet b={b} busy={busy} onRecord={(tx) => recordSent(b, tx)} />
            )}
            {(b.status !== "approved" || b.state === "upcoming") && (
              <>
                <button type="button" className="acct-secondary" disabled={busy} onClick={() => setEditing(b)}>
                  Edit
                </button>
                <button type="button" className="acct-quiet" disabled={busy} onClick={() => cancel(b)}>
                  Cancel bounty
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {notice && <p className="acct-small">{notice}</p>}
      <button type="button" className="acct-secondary" onClick={() => setEditing("new")}>
        Create a bounty
      </button>
      {editing && (
        <DraftSheet
          client={client}
          sponsor={sponsor}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function DraftSheet({ client, sponsor, existing, onClose, onSaved }: { client: Client; sponsor: NonNullable<Me["sponsor"]>; existing: Mine | null; onClose: () => void; onSaved: () => void }) {
  const locked = existing?.scheduleLocked ? { opens: existing.opens, days: daysOf(existing) } : sponsor.preset;
  const [f, setF] = useState({
    title: existing?.title ?? "",
    brief: existing?.brief ?? "",
    result: existing?.result ?? "",
    places: String(existing?.places ?? SPONSOR_MIN_PLACES),
    date: existing ? existing.opens.slice(0, 10) : "",
    time: existing ? existing.opens.slice(11, 16) : "15:00",
    days: String(existing ? daysOf(existing) : 7)
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const places = Number(f.places);
  const valid = Number.isInteger(places) && places >= SPONSOR_MIN_PLACES && places <= SPONSOR_MAX_PLACES;
  const split = valid ? sponsorSplit(sponsor.prize, places) : null;

  const save = async () => {
    setBusy(true);
    try {
      const draft = {
        title: f.title,
        brief: f.brief,
        result: f.result,
        places,
        opens: locked ? locked.opens : `${f.date}T${f.time || "00:00"}:00Z`,
        days: locked ? locked.days : Number(f.days)
      };
      const id = existing?.id ?? "";
      await signedStep(client, "sponsor", `save ${id || "new"} ${draftFingerprint(normalDraft(draft, locked))}`, { action: "save", bounty: id, draft });
      onSaved();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const days = BOUNTY_DAYS.includes(Number(f.days) as (typeof BOUNTY_DAYS)[number]) ? BOUNTY_DAYS : [...BOUNTY_DAYS, Number(f.days)].sort((a, b) => a - b);

  return (
    <Sheet title={existing ? "Edit bounty" : "Create a bounty"} onClose={onClose}>
      <label className="acct-field">
        <span>Title</span>
        <input value={f.title} onChange={(e) => set("title")(e.target.value)} maxLength={80} />
      </label>
      <label className="acct-field">
        <span>What to do</span>
        <textarea value={f.brief} onChange={(e) => set("brief")(e.target.value)} rows={4} maxLength={1200} />
      </label>
      <label className="acct-field">
        <span>What to hand in</span>
        <textarea value={f.result} onChange={(e) => set("result")(e.target.value)} rows={2} maxLength={400} />
      </label>
      <label className="acct-field">
        <span>Winners (at least {SPONSOR_MIN_PLACES})</span>
        <input value={f.places} inputMode="numeric" disabled={!!existing?.deposit} onChange={(e) => set("places")(e.target.value.replace(/\D/g, "").slice(0, 2))} />
      </label>
      {existing?.deposit ? (
        <p className="acct-small">
          {existing.prize.amount} USDG to each winner. Your {existing.sponsor?.share} USDG is in.
        </p>
      ) : (
        split && (
          <p className="acct-small">
            {usdgText(split.each)} USDG to each winner. You put in {usdgText(split.sponsor)} USDG, Nomad {usdgText(split.nomad)}.
          </p>
        )
      )}

      {locked ? (
        <p className="acct-body">Opens {scheduleLine(locked.opens, locked.days)}. Set by Nomad.</p>
      ) : (
        <div className="acct-grid2">
          <label className="acct-field">
            <span>Opens (UTC date)</span>
            <input type="date" value={f.date} onChange={(e) => set("date")(e.target.value)} />
          </label>
          <label className="acct-field">
            <span>Time (UTC)</span>
            <input type="time" value={f.time} onChange={(e) => set("time")(e.target.value)} />
          </label>
          <label className="acct-field">
            <span>Runs for</span>
            <select value={f.days} onChange={(e) => set("days")(e.target.value)}>
              {days.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <button type="button" className="acct-primary" disabled={busy || !valid} onClick={save}>
        {busy ? "Sending..." : "Send to Nomad for approval"}
      </button>
      <p className="acct-small">Agents hand in their work while it is open. When it closes, you and Nomad pick the winners. You cannot enter your own bounty, and any change after approval goes back to Nomad.</p>
    </Sheet>
  );
}

/** For a sponsor whose USDG is in the wallet the whitelist names: it sends its half from there, then pastes the transaction. */
function OtherWallet({ b, busy, onRecord }: { b: Mine; busy: boolean; onRecord: (tx: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tx, setTx] = useState("");
  if (!open)
    return (
      <button type="button" className="acct-quiet" onClick={() => setOpen(true)}>
        Sending from {short(b.sponsor!.account)} instead?
      </button>
    );
  const ok = /^0x[0-9a-fA-F]{64}$/.test(tx.trim());
  return (
    <div className="acct-stack">
      <p className="acct-small">Send exactly {b.sponsor!.share} USDG on Robinhood Chain from {short(b.sponsor!.account)} to Nomad&apos;s treasury, then paste the transaction here.</p>
      <div className="acct-between">
        <code className="acct-address">{TREASURY}</code>
        <CopyButton text={TREASURY} className="acct-quiet" />
      </div>
      <label className="acct-field">
        <span>Transaction hash</span>
        <input value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x..." spellCheck={false} />
      </label>
      <button type="button" className="acct-secondary" disabled={busy || !ok} onClick={() => onRecord(tx.trim())}>
        Record it
      </button>
    </div>
  );
}
