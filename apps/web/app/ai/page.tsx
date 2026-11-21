import Link from "next/link";
import { AgentLive } from "@/components/AgentLive";
import { SiteFooter } from "@/components/SiteFooter";
import { AGENT_LIMITS } from "@/lib/agent";

export const metadata = {
  title: "Nomad AI",
  description:
    "Nomad AI is an autonomous agent that reads markets and other agents across Robinhood Chain, decides for itself and trades tiny, hard-capped amounts with a public wallet. Watch it live."
};

const STEPS = [
  ["Check in", "It recalls what it did before from its memory on Memoria, so every run builds on the last."],
  ["Look around", "It reads both of its wallets, the market (Stoa and HEY Research) and what other traders and agents are doing (Rushr and Zolva)."],
  ["Decide", "It picks at most one idea. Doing nothing is a good decision when nothing is clear, and many runs end that way."],
  ["Act", "If it trades, it follows one fixed path: a fresh safety check, a fresh quote for exactly that amount, then the trade."],
  ["Record", "It saves what it did and why to its memory and writes a short report of the run."]
] as const;

const LIMITS = [
  [`${AGENT_LIMITS.perTradeUsd} USD`, "the most it can put into one trade"],
  [`${AGENT_LIMITS.tradesPerDay} a day`, "the most trades it can make in a UTC day, across every service"],
  [`${AGENT_LIMITS.maxImpactPct}%`, "the most price impact a trade may have, from a quote taken just before it"],
  ["Checked tokens only", "every token needs a fresh safety check that passed, from Stoa or from Rushr"],
  ["Two pairs", "trades only against USDG through Oak, or against ETH on Rushr"],
  ["Nothing else", "no transfers, lending, borrowing, bridging, leverage, launches or approvals of its own"]
] as const;

const SERVICES = [
  ["Trades with", "Oak, Rushr"],
  ["Reads", "Stoa, HEY Research, Rushr, Zolva, QHooks, Priors, Hedgehood, BrainChain, Tokyo Futuro"],
  ["Remembers with", "Memoria"],
  ["Moves between apps with", "Nomad"]
] as const;

export default function NomadAIPage() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "48px 20px 80px" }}>
        <p className="label">Live agent</p>
        <h1 style={{ marginTop: 12, fontSize: "clamp(2rem, 4vw, 3rem)" }}>Nomad AI</h1>
        <p className="lede" style={{ marginTop: 14, marginBottom: 32 }}>
          An autonomous agent built with Nomad. It reads markets and other agents across Robinhood Chain, makes its own decisions and trades tiny, hard-capped amounts from public wallets, so every move it makes can be checked on-chain. It started with {AGENT_LIMITS.startingUsdg} USDG.
        </p>

        <AgentLive />

        <section className="section" aria-labelledby="how" style={{ borderBottom: 0, paddingBottom: 24 }}>
          <div className="section-head">
            <h2 id="how">How each run goes</h2>
            <p>It runs on a schedule, several times a day. Every run is short and follows the same five steps.</p>
          </div>
          <ol className="steps">
            {STEPS.map(([title, text], i) => (
              <li key={title}>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <h3 style={{ margin: 0 }}>{title}</h3>
                <p style={{ margin: 0 }}>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" aria-labelledby="limits" style={{ borderBottom: 0, paddingBottom: 24 }}>
          <div className="section-head">
            <h2 id="limits">Its limits</h2>
            <p>
              The limits are not instructions it is asked to follow. A guard outside the model checks every action before it runs and refuses anything over a limit, whatever the agent was told or talked into.
            </p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {LIMITS.map(([what, why]) => (
                  <tr key={what}>
                    <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{what}</td>
                    <td className="why">{why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            Every decision the guard makes goes into a tamper-evident log, and a stop switch halts all trading at once. Text it reads, such as token names, posts and research, is treated as data, never as instructions.
          </p>
        </section>

        <section className="section" aria-labelledby="services" style={{ borderBottom: 0, paddingBottom: 24 }}>
          <div className="section-head">
            <h2 id="services">What it uses</h2>
            <p>
              One agent working across many services on Robinhood Chain, and keeping who it is when it moves between apps. That is what <Link href="/">Nomad</Link> is for.
            </p>
          </div>
          <dl className="kv">
            {SERVICES.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="muted" style={{ marginTop: 32 }}>
          Nomad AI is a demonstration of Nomad, not a fund. It never promises returns, and nothing it does or writes is financial advice.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
