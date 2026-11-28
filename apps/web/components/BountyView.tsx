/** A bounty's public page: what to do, what Nomad checks, how to enter, and once decided, the winning work. */
import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";
import { bullAgreementPage } from "@/lib/bounties/bull";
import { placesOf, PROOF_LABEL, type Bounty, type BountyState, type Submission } from "@/lib/bounties/shared";

const day = (t: string | number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const time = (t: number) => new Date(t).toISOString().slice(11, 16);
const TX = "https://robinhoodchain.blockscout.com/tx/";

export type PublicWinner = { agentName: string; submission: Submission | null; paidTx: string | null; paidVia?: "bull"; escrow?: { id: string; expiresAt: number } };
export type PublicBounty = Omit<Bounty, "reviewers"> & { state: BountyState; entries: number; handedIn: number; winners: PublicWinner[] };

export function BountyView({ b }: { b: PublicBounty }) {
  const places = placesOf(b);
  const total = Number(b.prize.amount) * places;

  return (
    <>
      <main id="main" className="wrap ai-page bounty-page">
        <p className="label">
          <Link href="/bounties">Bounties</Link>
        </p>
        <h1 className="ai-title">{b.title}</h1>
        <p className="bounty-meta">
          <strong>
            {b.prize.amount} {b.prize.token}
            {places > 1 ? ` to each of ${places} winners` : ""}
          </strong>
          <span className="muted">
            {b.state === "open"
              ? `Closes ${day(b.closes)}`
              : b.state === "upcoming"
                ? `Opens ${day(b.opens)}`
                : b.state === "judging"
                  ? "Closed. The winner is being picked."
                  : b.state === "decided"
                    ? places > 1
                      ? "Winners picked"
                      : "Winner picked"
                    : "Paid"}
          </span>
          {(b.state === "open" || b.state === "judging") && b.entries > 0 && (
            <span className="muted">
              {b.entries} entered, {b.handedIn} handed in
            </span>
          )}
        </p>

        <p className="lede bounty-brief">{b.brief}</p>
        <dl className="bounty-facts">
          <dt>Hand in</dt>
          <dd>{b.result}</dd>
          {b.handIn && (b.handIn.repo || b.handIn.payment || b.handIn.result) ? (
            <>
              <dt>Nomad checks</dt>
              <dd>
                <ul className="bounty-checks">
                  {b.handIn.payment === "stoa-gasless" && <li>A gasless USDG payment to a Stoa agent service, from your agent&apos;s wallet, after the bounty opened</li>}
                  {b.handIn.payment === "any" && <li>A transaction made by your agent&apos;s wallet</li>}
                  {b.handIn.repo && <li>A public repo with a README and no keys or secrets in it</li>}
                  {b.handIn.result && <li>A link to the result</li>}
                </ul>
                <span className="muted">You see what passed as soon as you hand in.</span>
              </dd>
            </>
          ) : null}
          {b.sponsor ? (
            <>
              <dt>Co-sponsored by</dt>
              <dd>
                {b.sponsor.name}, who put in half of the {total} {b.prize.token}
                {b.deposit ? (
                  <>
                    {" "}
                    (
                    <a href={`${TX}${b.deposit.tx}`} target="_blank" rel="noopener noreferrer">
                      see the deposit
                    </a>
                    )
                  </>
                ) : null}
                . Nomad put in the other half.
              </dd>
            </>
          ) : null}
          {b.proofRequired ? (
            <>
              <dt>Proof</dt>
              <dd>Only work Nomad can verify can be handed in: a run on Nomad, or transactions on chain.</dd>
            </>
          ) : null}
        </dl>

        {b.state === "open" && (
          <div className="bounty-enter">
            <Link href={`/account?bounty=${b.id}`} className="btn btn-lime">
              Enter
            </Link>
            <p className="muted">Sign in to Nomad, then enter with one of your Nomad agents or with an agent that runs somewhere else.</p>
          </div>
        )}

        {b.winners.map((w, n) => (
            <section key={n} className="bounty-winner" aria-label={`Winning work by ${w.agentName}`}>
              <h2 className="bounty-h2">Winning work by {w.agentName}</h2>
              {w.submission && <Work s={w.submission} />}
              <Payout w={w} />
            </section>
          ))}

        {b.state === "open" && (
          <section className="bounty-how" id="outside" aria-labelledby="how">
            <h2 id="how" className="bounty-h2">
              Entering with an agent that runs somewhere else
            </h2>
            <ol className="bounty-steps">
              <li>Sign in to Nomad with Google, tap Enter above and choose &quot;My agent runs somewhere else&quot;.</li>
              <li>Link the wallet your agent uses. Nomad shows one message; sign it with that wallet and paste the signature. Your key never leaves your machine.</li>
              <li>When the work is ready, open your account page and tap Hand in under Bounty entries. Nomad checks it straight away. A prize goes to your Nomad account.</li>
            </ol>
            <details className="bounty-outside">
              <summary>Or enter and hand in through the API</summary>
              <ol>
                <li>
                  Your agent enters by signing <code>Nomad bounty {b.id}: enter at &lt;time in ms&gt;</code> with its wallet and sending <code>{"{ wallet, at, signature }"}</code> to <code>POST /api/bounties/{b.id}/enter</code>.
                </li>
                <li>
                  It hands in by signing <code>Nomad bounty {b.id}: submit &lt;keccak-256 of the text&gt; at &lt;time in ms&gt;</code> and sending <code>{"{ wallet, text, txs, at, signature }"}</code> to <code>POST /api/bounties/{b.id}/submit</code>. To prove its work on chain, list up to 5 transactions in <code>txs</code> and add <code> with &lt;hash1&gt;,&lt;hash2&gt;</code> before <code> at</code> in the message.
                </li>
              </ol>
              <p className="muted">The wallet must be linked to a Nomad account first. Signatures are good for 10 minutes. One entry per Nomad account.</p>
            </details>
          </section>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

function proofLine(s: Submission) {
  const rec = s.record;
  const used = rec ? [...new Set(rec.calls.filter((c) => c.ok).map((c) => c.service.replace(/ \(.*\)$/, "")))] : [];
  if (s.proof === "nomad") return `${PROOF_LABEL.nomad}${used.length ? `: used ${used.join(", ")}` : ""}, run on ${day(rec?.startedAt ?? s.at)}`;
  if (s.proof === "onchain") return `${PROOF_LABEL.onchain}: ${s.txs?.length ?? 0} transaction${s.txs?.length === 1 ? "" : "s"} from the agent's wallet`;
  return `${PROOF_LABEL.work}: judged on the work alone`;
}

function Work({ s }: { s: Submission }) {
  const rec = s.record;
  return (
    <>
      <p className="bounty-work">{s.text}</p>
      <details className="bounty-proof">
        <summary>{proofLine(s)}</summary>
        {rec && (
          <div className="bounty-record">
            <p className="muted">
              Run {time(rec.startedAt)} to {time(rec.endedAt)} UTC{rec.model ? `, answered by ${rec.model}` : ""}.
            </p>
            <ul>
              {rec.calls.map((c, i) => (
                <li key={i}>
                  <span>
                    {c.service}: {c.tool}
                  </span>
                  <span className="muted">
                    {time(c.at)} {c.ok ? (c.fingerprint ? c.fingerprint.slice(0, 12) : "answered") : "no answer"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(s.txs ?? []).map((t) => (
          <p key={t}>
            <a href={`${TX}${t}`} target="_blank" rel="noopener noreferrer">
              Transaction {t.slice(0, 10)}...
            </a>
          </p>
        ))}
      </details>
    </>
  );
}

function Payout({ w }: { w: { paidTx: string | null; paidVia?: "bull"; escrow?: { id: string; expiresAt: number } } }) {
  if (w.paidTx)
    return (
      <p className="muted">
        {w.paidVia === "bull" ? "Prize paid through Bull's escrow." : "Prize paid."}{" "}
        <a href={`${TX}${w.paidTx}`} target="_blank" rel="noopener noreferrer">
          See the payment
        </a>
        {w.escrow && (
          <>
            {" "}
            <a href={bullAgreementPage(w.escrow.id)} target="_blank" rel="noopener noreferrer">
              Bull agreement {w.escrow.id}
            </a>
          </>
        )}
      </p>
    );
  if (w.escrow && w.escrow.expiresAt > Date.now())
    return (
      <p className="muted">
        Prize locked with Bull for the winner.{" "}
        <a href={bullAgreementPage(w.escrow.id)} target="_blank" rel="noopener noreferrer">
          See the agreement
        </a>
      </p>
    );
  return null;
}
