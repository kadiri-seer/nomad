"use client";

/**
 * A whitelisted sponsor's bounties, shown on the account page only to sponsors. The sponsor writes a bounty and sends
 * it to Nomad; Nomad approves it (setting its own share and the schedule); the sponsor then funds its share from this
 * Nomad account to the treasury. Its entries and winners are picked from Bounty review. Every step is signed by the
 * sponsor's sign-in wallet.
 */
import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { topUpUsdgCalls } from "@/lib/accounts/client";
import { BOUNTY_DAYS, draftFingerprint, normalDraft, type Entrants, type StoredBounty } from "@/lib/bounties/shared";
import { Sheet } from "./Sheet";
import { daysOf, fail, scheduleLine, signedStep } from "./bounty-sign";
import type { Client, Confirm } from "./types";

type Mine = StoredBounty & { state: string | null; entries: number; awards: number };
type Me = { sponsor: { name: string; account: string; preset: { opens: string; days: number } | null; maxPrize: string } | null; bounties?: Mine[] };

const ENTRANTS: [Entrants, string, string][] = [
  ["any", "Any agent", "Hosted on Nomad or running anywhere else"],
  ["hosted", "Hosted on Nomad", "Its run record is the proof"],
  ["outside", "Running elsewhere", "Linked to a Nomad account, signs its work"]
];

/** What a sponsor's bounty is doing, in a few words. */
function statusLine(b: Mine) {
  if (b.status === "waiting") return "Waiting for Nomad's approval";
  if (b.status === "returned") return "Sent back for changes";
  if (b.sponsor && Number(b.sponsor.share) > 0 && !b.deposit) return "Approved. Fund your share to open it";
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

  const fund = (b: Mine) =>
    onConfirm({
      title: "Fund your share",
      amount: `${b.sponsor!.share} USDG`,
      amountNote: `Your share of ${b.title}`,
      rows: [
        ["To", "Nomad's treasury"],
        ["Whole prize", `${(Number(b.prize.amount) * (b.places ?? 1)).toString()} USDG`],
        ["Nomad puts in", `${b.nomadShare ?? "0"} USDG`]
      ],
      note: "Nomad holds the prize in its treasury until the winners are paid. If the bounty is cancelled before it opens, your share is sent back.",
      build: async () => topUpUsdgCalls(parseUnits(b.sponsor!.share, 6)),
      after: async (txHash) => {
        // The transfer is read on chain; retry while the chain catches up.
        for (let i = 0; ; i++) {
          try {
            await signedStep(client, "sponsor", `deposit ${b.id} ${txHash.toLowerCase()}`, { action: "deposit", bounty: b.id, tx: txHash });
            break;
          } catch (e) {
            if (i >= 4) return `Sent, but Nomad could not read it yet. Open this page again in a minute and tap Fund your share to record it.`;
            await new Promise((r) => setTimeout(r, 4000));
          }
        }
        await load();
      },
      done: { title: "Share funded", body: "Your bounty opens on its start date." }
    });

  return (
    <section className="acct-card">
      <h2 className="acct-h3">Your bounties</h2>
      <p className="acct-body">Post a bounty as {sponsor.name}. Nomad approves it before it shows, and you fund your share from this account.</p>
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
                Fund your share
              </button>
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
    prize: existing?.prize.amount ?? "",
    places: String(existing?.places ?? 1),
    share: existing?.sponsor?.share ?? "",
    entrants: (existing?.entrants ?? "any") as Entrants,
    firstValidWins: !!existing?.firstValidWins,
    privateUntilReleased: !!existing?.privateUntilReleased,
    freeScanRejects: !!existing?.freeScanRejects,
    date: existing ? existing.opens.slice(0, 10) : "",
    time: existing ? existing.opens.slice(11, 16) : "15:00",
    days: String(existing ? daysOf(existing) : 7)
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const deposited = !!existing?.deposit;

  const total = Number(f.prize || 0) * Number(f.places || 1);
  const nomad = total - Number(f.share || 0);
  const save = async () => {
    setBusy(true);
    try {
      const draft = {
        title: f.title,
        brief: f.brief,
        result: f.result,
        prize: f.prize,
        share: f.share || "0",
        places: Number(f.places),
        entrants: f.entrants,
        firstValidWins: f.firstValidWins,
        privateUntilReleased: f.privateUntilReleased,
        freeScanRejects: f.freeScanRejects,
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

      <div className="acct-grid2">
        <label className="acct-field">
          <span>Prize per winner (USDG)</span>
          <input value={f.prize} inputMode="decimal" disabled={deposited} onChange={(e) => set("prize")(e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} />
        </label>
        <label className="acct-field">
          <span>Winners</span>
          <input value={f.places} inputMode="numeric" disabled={deposited} onChange={(e) => set("places")(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </label>
      </div>
      <label className="acct-field">
        <span>Your share of the whole prize (USDG)</span>
        <input value={f.share} inputMode="decimal" disabled={deposited} onChange={(e) => set("share")(e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))} />
      </label>
      {total > 0 && (
        <p className="acct-small">
          Whole prize {total} USDG, at most {sponsor.maxPrize}. You put in {Number(f.share || 0)}, Nomad {nomad > 0 ? nomad : 0}. Nomad can change its own share when it approves.
        </p>
      )}

      <fieldset className="acct-fieldset">
        <legend>Who can enter</legend>
        {ENTRANTS.map(([id, label, note]) => (
          <button key={id} type="button" className="acct-option" aria-pressed={f.entrants === id} onClick={() => set("entrants")(id)}>
            <span>
              <strong>{label}</strong>
              <span className="acct-small">{note}</span>
            </span>
            <span className="acct-dot" aria-hidden="true" />
          </button>
        ))}
      </fieldset>

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

      <fieldset className="acct-fieldset">
        <legend>Rules</legend>
        <label className="acct-confirm">
          <input type="checkbox" checked={f.firstValidWins} onChange={(e) => set("firstValidWins")(e.target.checked)} />
          <span>The first valid entry can win. You can pick before it closes, and the bounty ends when every place is picked.</span>
        </label>
        <label className="acct-confirm">
          <input type="checkbox" checked={f.privateUntilReleased} onChange={(e) => set("privateUntilReleased")(e.target.checked)} />
          <span>Keep the winning work private until you release it.</span>
        </label>
        <label className="acct-confirm">
          <input type="checkbox" checked={f.freeScanRejects} onChange={(e) => set("freeScanRejects")(e.target.checked)} />
          <span>Work Venin turns away does not use up one of the entrant&apos;s 3 tries.</span>
        </label>
      </fieldset>

      <button type="button" className="acct-primary" disabled={busy} onClick={save}>
        {busy ? "Sending..." : "Send to Nomad for approval"}
      </button>
      <p className="acct-small">You and your reviewers cannot enter your own bounty. Any change after approval goes back to Nomad.</p>
    </Sheet>
  );
}
