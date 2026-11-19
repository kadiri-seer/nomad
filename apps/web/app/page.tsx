import Link from "next/link";
import { ALL_INFOS } from "@nomad/adapters/catalog";
import { CompatDemo } from "@/components/CompatDemo";
import { InstallNomad } from "@/components/InstallNomad";
import { REPO_URL, SiteFooter } from "@/components/SiteFooter";

const STEPS = [
  { t: "Read the agent where it lives", d: "Nomad finds OpenClaw, Claude Code, Codex and Hermes agents on your machine and reads instructions, persona, memory, skills, tools, routines and permissions into one portable format." },
  { t: "See what will transfer", d: "Before anything changes you get a preview: what moves as is, what gets converted, what has no equivalent at the destination, which files change and which permissions differ." },
  { t: "Resolve conflicts on your terms", d: "Merge keeps everything already at the destination. Copy creates a separate agent. Replace overwrites, and only after you approve exactly what it touches." },
  { t: "Apply, verify, keep a receipt", d: "Writes are atomic and backed up first. Nomad reads the result back to verify it, records a receipt, and can restore the previous state in one step." }
];

const HOME = [
  { t: "Show", d: "Ask \u201cNomad, show my agents\u201d to see every agent you have, the apps it lives in, and any copy that is behind." },
  { t: "Borrow", d: "Use an agent in the chat you are in. Nothing is written anywhere, and secrets are never included." },
  { t: "Bring", d: "Install an agent in this app for good, with its tools and skills, after a preview you approve." },
  { t: "Send back", d: "Save what an agent learned to the home as a new version, ready for its other copies." }
];

const SAFETY = [
  "Local first. Nothing is uploaded; there is no account.",
  "Secrets are detected and redacted before export, import and migration.",
  "The source agent is never modified.",
  "Every migration is a transaction with a backup and a rollback.",
  "Files you edited after Nomad wrote them are never overwritten silently.",
  "Packages are checked for path traversal, symlinks, bombs and tampering."
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
                <p className="lede">
                  Nomad carries an agent&apos;s instructions, persona, memory, skills, tools and routines from one platform to another. It shows you what will transfer before it touches a file, and keeps a backup after.
                </p>
                <div className="hero-actions">
                  <Link href="/docs" className="btn btn-lime">
                    Get started
                  </Link>
                  <Link href="/inspect" className="btn btn-ghost">
                    Inspect a package
                  </Link>
                </div>
                <p style={{ marginTop: 28, fontSize: "0.9rem", opacity: 0.85 }}>
                  The migration preview here runs Nomad&apos;s real compatibility engine on a sample agent. Change the platforms to see it update.
                </p>
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

        <section className="section" id="download">
          <div className="wrap split">
            <div>
              <p className="label">Download</p>
              <h2 style={{ marginTop: 12 }}>Install Nomad in one line.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Paste one line once, and Nomad is on your computer like any other app. No Node.js, no admin rights, nothing to set up. Everything after that is clicks.
              </p>
              <p className="muted" style={{ marginTop: 18 }}>
                Developers can also run it straight from npm: <code>npx thenomad</code>. The app, the command line and the MCP server share one engine.
              </p>
            </div>
            <InstallNomad />
          </div>
        </section>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <div>
                <p className="label">How it works</p>
                <h2 style={{ marginTop: 12 }}>A migration you can read before you run it.</h2>
              </div>
              <p>Copying instruction files is the easy part. Nomad maps each platform&apos;s structure into a common format, then writes the closest faithful version at the destination and tells you exactly where it could not. <Link href="/docs/format">See what travels</Link>.</p>
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

        <section className="section" id="your-nomad">
          <div className="wrap split">
            <div>
              <p className="label">Your Nomad</p>
              <h2 style={{ marginTop: 12 }}>Every agent you have, in one home.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Reach your home from inside the app you are working in. Run <code>nomad connect</code> once, then ask for the agent you want. It runs on your computer: no account, nothing uploaded.
              </p>
              <a href={`${REPO_URL}/blob/main/docs/guides/your-nomad.md`} className="btn btn-quiet" style={{ marginTop: 24 }}>
                Read the guide
              </a>
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

        <section className="section" id="security">
          <div className="wrap split">
            <div>
              <p className="label">Safety</p>
              <h2 style={{ marginTop: 12 }}>Built so a migration cannot quietly go wrong.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Moving an agent means touching its credentials, its permissions and files you care about. Nomad treats each of those as a first class concern.
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
                <Link href="/inspect" className="btn btn-ghost" style={{ color: "var(--band-ink)" }}>
                  Try the inspector
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
