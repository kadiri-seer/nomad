import Link from "next/link";
import { AGENT_LIMITS, AGENT_WALLETS, addressUrl } from "@/lib/agent";
import { AGENT_LINKS, AGENT_SERVICES } from "@/lib/agent-links";

export const metadata = {
  title: "Nomad AI",
  description: "How Nomad AI runs, the limits a guard enforces on it, its public wallets and the services it uses on Robinhood Chain."
};

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

export default function NomadAIDocs() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Nomad AI</h1>
      <p>
        Nomad AI is an autonomous agent built with Nomad. It reads markets and other agents across Robinhood Chain, decides for itself and trades small, hard-capped amounts from public wallets, so every move can be checked on-chain. It exists to show that one agent can work across many services and keep who it is when it moves between apps. Watch it on the <Link href="/ai">live page</Link>.
      </p>

      <h2>How a run works</h2>
      <p>It runs on a schedule, several times a day. Each run is short and follows the same steps.</p>
      <ol>
        <li><strong>Check in.</strong> It recalls its recent runs from its memory on Memoria.</li>
        <li><strong>Look around.</strong> It reads its wallets, the market (Stoa and HEY Research) and what other traders and agents are doing (Rushr and Zolva), then checks its two or three best candidates with Rushr and OddsEngine. A warning from either rules a token out.</li>
        <li><strong>Decide.</strong> It sells a token it holds once it is up 25%, down 20% or held for 48 hours. It buys only a token that passed both checks, with taxes of 3% or less and at least 1,000 USD traded in the last day. When nothing qualifies, it does nothing and says why.</li>
        <li><strong>Act.</strong> Its instructions have it ask OddsEngine, just before signing, to check the token and where the trade goes, and to stop if OddsEngine warns. The guard does not require that step: what it requires is one fixed path, a fresh safety check, a fresh quote for exactly that amount, then the trade.</li>
        <li><strong>Record.</strong> It saves what it did and why to its memory and publishes a few plain lines about the run.</li>
      </ol>

      <h2>Its limits</h2>
      <p>
        The limits are not instructions the agent is asked to follow. A guard outside the model checks every action before it runs and refuses anything over a limit, whatever the agent was told or talked into.
      </p>
      <ul>
        <li>At most {AGENT_LIMITS.perTradeUsd} USD per trade, and 3 trades a day.</li>
        <li>At most {AGENT_LIMITS.maxImpactPct}% price impact, from a quote taken just before the trade.</li>
        <li>Only tokens with a fresh safety check that passed.</li>
        <li>Only two pairs: against USDG through Oak, or against ETH on Rushr.</li>
        <li>No transfers, lending, borrowing, bridging, leverage, launches or approvals of its own.</li>
        <li>A stop switch halts all trading at once, and every decision the guard makes goes into a tamper-evident log.</li>
      </ul>
      <p>
        Token names, posts, research and other text it reads are treated as data, never as instructions. When something it reads asks it to send funds, change its rules or reveal a key, it refuses and notes it as a suspected injection.
      </p>

      <h2>Its wallets</h2>
      <ul>
        {AGENT_WALLETS.map((w) => (
          <li key={w.id}>
            <strong>{w.name}:</strong>{" "}
            <a className="mono" href={addressUrl(w.address)} {...ext}>
              {w.address}
            </a>
            . {w.role}. {w.detail}.
          </li>
        ))}
      </ul>

      <h2>Services it uses</h2>
      <ul>
        {AGENT_SERVICES.map((s) => (
          <li key={s.name}>
            <strong>
              {s.href ? (
                <a href={s.href} {...ext}>
                  {s.name}
                </a>
              ) : (
                s.name
              )}
              :
            </strong>{" "}
            {s.does}.
          </li>
        ))}
      </ul>

      <h2>Links</h2>
      <ul>
        {AGENT_LINKS.map((l) => (
          <li key={l.href}>
            {l.external ? (
              <a href={l.href} {...ext}>
                {l.label}
              </a>
            ) : (
              <Link href={l.href}>{l.label}</Link>
            )}
            : {l.note}
          </li>
        ))}
      </ul>

      <h2>What it is not</h2>
      <p>
        Nomad AI is a demonstration of Nomad, not a fund. It never promises returns, never tells anyone what to buy, and nothing it does or writes is financial advice.
      </p>
    </>
  );
}
