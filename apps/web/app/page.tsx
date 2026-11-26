import Link from "next/link";
import { ALL_INFOS } from "@nomad/adapters/catalog";
import { CompatDemo } from "@/components/CompatDemo";
import { InstallNomad } from "@/components/InstallNomad";
import { SiteFooter } from "@/components/SiteFooter";

const STEPS = [
  { t: "Read the agent", d: "Nomad finds your agent and reads everything that makes it who it is into one portable format." },
  { t: "Preview the move", d: "See what moves as is, what gets converted and what has no match, before any file changes." },
  { t: "Choose how it lands", d: "Merge, copy or replace. Nothing is overwritten without your approval." },
  { t: "Apply and verify", d: "Backed up first, checked after, and undone in one step if you change your mind." }
];

const HOME = [
  { t: "Show", d: "Ask \u201cNomad, show my agents\u201d to see every agent you have, the apps it lives in, and any copy that is behind." },
  { t: "Borrow", d: "Use an agent in the chat you are in. Nothing is written anywhere, and secrets are never included." },
  { t: "Bring", d: "Install an agent in this app for good, with its tools and skills, after a preview you approve." },
  { t: "Send back", d: "Save what an agent learned to the home as a new version, ready for its other copies." }
];

const AGENT_STEPS = [
  { t: "Sign in", d: "Google sign-in makes your account on Robinhood Chain. No wallet app, no seed phrase, no ETH." },
  { t: "Create", d: "A Trader, a Stocks agent, a Researcher, or your own instructions. A one-time fee in $NOMAD: half is burned, half goes to Nomad's treasury." },
  { t: "Fund", d: "Give it USDG to trade with and credits for its network fees. Take everything back whenever you like." },
  { t: "Watch", d: "Every move it makes is listed with its transaction, on your account page and on-chain." }
];

const SAFETY = [
  "Local first. Nothing is uploaded, and there is no account.",
  "Secrets are found and removed before anything moves.",
  "The source agent is never changed.",
  "Every move has a backup and a one-step undo."
];

export default function Home() {
  const direct = ALL_INFOS.filter((a) => a.support !== "GUIDED");
  const guided = ALL_INFOS.filter((a) => a.support === "GUIDED");
  return (
    <>
      <main id="main">
        <section className="hero">
          <div className="hero-panel on-blue">
            <div className="wrap hero-grid">
              <div>
                <p className="label">Agent portability</p>
                <h1 style={{ marginTop: 18 }}>Move your agents without losing who they are.</h1>
                <p className="lede">Take an agent&apos;s instructions, memory, skills and tools to another platform. See what transfers first, keep a backup after.</p>
                <div className="hero-actions">
                  <Link href="/docs" className="btn btn-lime">
                    Get started
                  </Link>
                  <Link href="/inspect" className="btn btn-ghost">
                    Inspect a package
                  </Link>
                </div>
              </div>
              <CompatDemo />
            </div>
          </div>
        </section>

        <div className="wrap">
          <div className="platform-strip" aria-label="Supported platforms">
            {direct.slice(0, 9).map((a) => (
              <span key={a.id}>{a.displayName}</span>
            ))}
            <Link href="/docs/adapters">and {direct.length - 9 + guided.length} more</Link>
          </div>
        </div>

        <section className="section" id="agents">
          <div className="wrap split">
            <div>
              <p className="label">Agents on Robinhood Chain</p>
              <h2 style={{ marginTop: 12 }}>Create an agent that trades on its own.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                It runs in Nomad&apos;s cloud, checks every token for safety first, and never goes past the limits you set.
              </p>
              <div className="row" style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
                <Link href="/account" className="btn">
                  Create an agent
                </Link>
                <Link href="/docs/agents" className="btn btn-quiet">
                  How it works
                </Link>
              </div>
              <p className="muted" style={{ marginTop: 16, fontSize: "0.92rem" }}>
                Agents trade real money and can lose it. Nothing here is financial advice.
              </p>
            </div>
            <dl style={{ margin: 0 }}>
              {AGENT_STEPS.map((c) => (
                <div key={c.t} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 16, padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
                  <dt style={{ fontWeight: 600 }}>{c.t}</dt>
                  <dd style={{ margin: 0, color: "var(--ink-2)" }}>{c.d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="section" id="download">
          <div className="wrap split">
            <div>
              <p className="label">Download</p>
              <h2 style={{ marginTop: 12 }}>Install Nomad in one line.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Paste one line once and Nomad is on your computer like any other app. No setup, no admin rights.
              </p>
              <p className="muted" style={{ marginTop: 14 }}>
                Developers: <code>npx thenomad</code>
              </p>
            </div>
            <InstallNomad />
          </div>
        </section>

        <section className="section" id="your-nomad">
          <div className="wrap split">
            <div>
              <p className="label">Your Nomad</p>
              <h2 style={{ marginTop: 12 }}>Every agent you have, in one home.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Run <code>nomad connect</code> once, then ask for any agent from the app you are in.
              </p>
              <div className="yn-chat" aria-label="Example: asking for your agents inside an app">
                <p className="yn-you">Nomad, show my agents</p>
                <div className="yn-reply">
                  <p>You have 3 agents:</p>
                  <ul>
                    <li>
                      <strong>Kestrel</strong>, research. In Claude Code and OpenClaw.
                    </li>
                    <li>
                      <strong>Ledger</strong>, bookkeeping. In Codex, one version behind.
                    </li>
                    <li>
                      <strong>Scout</strong>, trading. Not in any app yet.
                    </li>
                  </ul>
                </div>
                <p className="yn-note">An example. Your list shows your own agents.</p>
              </div>
              <Link href="/docs/your-nomad" className="btn btn-quiet" style={{ marginTop: 24 }}>
                How Your Nomad works
              </Link>
            </div>
            <dl style={{ margin: 0 }}>
              {HOME.map((c) => (
                <div key={c.t} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 16, padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
                  <dt style={{ fontWeight: 600 }}>{c.t}</dt>
                  <dd style={{ margin: 0, color: "var(--ink-2)" }}>{c.d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <div>
                <p className="label">How it works</p>
                <h2 style={{ marginTop: 12 }}>A migration you can read before you run it.</h2>
              </div>
              <p>Nomad writes the closest faithful version at the destination and tells you exactly where it could not. <Link href="/docs/format">See what travels</Link>.</p>
            </div>
            <ol className="steps steps-grid">
              {STEPS.map((s, i) => (
                <li key={s.t}>
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section" id="security">
          <div className="wrap split">
            <div>
              <p className="label">Safety</p>
              <h2 style={{ marginTop: 12 }}>Built so a migration cannot quietly go wrong.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Moving an agent touches its keys, its permissions and your files. Nomad guards each one.
              </p>
              <Link href="/docs/security" className="btn btn-quiet" style={{ marginTop: 24 }}>
                Security model
              </Link>
            </div>
            <ul className="marks">
              {SAFETY.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </section>

        <section style={{ padding: "64px 0" }}>
          <div className="wrap">
            <div className="cta-band">
              <h2>Your agent, wherever you work next.</h2>
              <div className="row">
                <Link href="/docs" className="btn btn-lime">
                  Get started
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
