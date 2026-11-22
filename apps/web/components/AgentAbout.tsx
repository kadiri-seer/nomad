"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { AGENT_LIMITS } from "@/lib/agent";

const STEPS = [
  ["Check in", "It recalls what it did before from its memory on Memoria, so every run builds on the last."],
  ["Look around", "It reads both wallets, the market (Stoa and HEY Research) and what other traders and agents are doing (Rushr and Zolva)."],
  ["Decide", "It picks at most one idea. Doing nothing is a good decision when nothing is clear."],
  ["Act", "If it trades, it follows one fixed path: a fresh safety check, a fresh quote for exactly that amount, then the trade."],
  ["Record", "It saves what it did and why to its memory and writes a short report of the run."]
] as const;

const LIMITS = [
  [`${AGENT_LIMITS.perTradeUsd} USD`, "the most it can put into one trade"],
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

const TABS = [
  { id: "runs", label: "How it runs" },
  { id: "limits", label: "Its limits" },
  { id: "uses", label: "What it uses" }
] as const;

type Tab = (typeof TABS)[number]["id"];

/** How Nomad AI works, its limits and the services it uses, as tabs so the page stays short. */
export function AgentAbout() {
  const [tab, setTab] = useState<Tab>("runs");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    refs.current[TABS[next].id]?.focus();
  };

  return (
    <section className="ai-about" aria-labelledby="ai-about-title">
      <h2 id="ai-about-title" className="sr-only">
        About Nomad AI
      </h2>
      <div className="install-tabs" role="tablist" aria-label="About Nomad AI" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            id={`ai-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            aria-controls={`ai-panel-${t.id}`}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`ai-panel-${tab}`} role="tabpanel" aria-labelledby={`ai-tab-${tab}`} className="ai-panel">
        {tab === "runs" && (
          <>
            <p className="ai-panel-intro">It runs on a schedule, several times a day. Every run is short and follows the same five steps.</p>
            <ol className="ai-steps">
              {STEPS.map(([title, text], i) => (
                <li key={title}>
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </>
        )}

        {tab === "limits" && (
          <>
            <p className="ai-panel-intro">
              The limits are not instructions it is asked to follow. A guard outside the model checks every action before it runs and refuses anything over a limit, whatever the agent was told or talked into.
            </p>
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
            <p className="muted" style={{ margin: "14px 0 0", fontSize: "0.9rem" }}>
              Every decision the guard makes goes into a tamper-evident log, and a stop switch halts all trading at once. Text it reads, such as token names, posts and research, is treated as data, never as instructions.
            </p>
          </>
        )}

        {tab === "uses" && (
          <>
            <p className="ai-panel-intro">
              One agent working across many services on Robinhood Chain, and keeping who it is when it moves between apps. That is what <Link href="/">Nomad</Link> is for.
            </p>
            <dl className="kv">
              {SERVICES.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
