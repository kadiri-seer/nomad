import Link from "next/link";
import { ALL_INFOS } from "@nomad/adapters/catalog";
import { CompatDemo } from "@/components/CompatDemo";
import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui";

const STEPS = [
  { t: "Read the agent where it lives", d: "Nomad finds OpenClaw, Claude Code, Codex and Hermes agents on your machine and reads instructions, persona, memory, skills, tools, routines and permissions into one portable format." },
  { t: "See what will transfer", d: "Before anything changes you get a preview: what moves as is, what gets converted, what has no equivalent at the destination, which files change and which permissions differ." },
  { t: "Resolve conflicts on your terms", d: "Merge keeps everything already at the destination. Copy creates a separate agent. Replace overwrites, and only after you approve exactly what it touches." },
  { t: "Apply, verify, keep a receipt", d: "Writes are atomic and backed up first. Nomad reads the result back to verify it, records a receipt, and can restore the previous state in one step." }
];

const COMPONENTS = [
  { t: "Identity", d: "Name, persona, tone and a permanent agent id, so the same agent is recognised on every platform." },
  { t: "Instructions", d: "System prompts, AGENTS.md style rules, conventions and slash commands." },
  { t: "Memory", d: "Profile, preferences, facts, project context and daily logs, kept as separate entries with their origin." },
  { t: "Skills", d: "Agent Skills folders with their scripts and files, converted between skills, commands and prompts." },
  { t: "Tools", d: "MCP servers with their configuration. Credentials become references you reconnect, never copied values." },
  { t: "Routines", d: "Scheduled jobs with their cron expression and timezone. Always imported paused." },
  { t: "Permissions", d: "Allow, ask and deny rules mapped to the destination. Nomad never widens what an agent may do without asking." }
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
            <span>and {direct.length - 9 + guided.length} more</span>
          </div>
        </div>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <div>
                <p className="label">How it works</p>
                <h2 style={{ marginTop: 12 }}>A migration you can read before you run it.</h2>
              </div>
              <p>Copying instruction files is the easy part. Nomad maps each platform&apos;s structure into a common format, then writes the closest faithful version at the destination and tells you exactly where it could not.</p>
            </div>
            <ol className="steps">
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

        <section className="section">
          <div className="wrap split">
            <div>
              <p className="label">What travels</p>
              <h2 style={{ marginTop: 12 }}>An agent is more than its system prompt.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                Every part is kept in the Universal Agent Format: versioned, validated JSON with Markdown for anything you would want to read.
              </p>
              <Link href="/docs/format" className="btn btn-quiet" style={{ marginTop: 24 }}>
                Read the format
              </Link>
            </div>
            <dl style={{ margin: 0 }}>
              {COMPONENTS.map((c) => (
                <div key={c.t} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 16, padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
                  <dt style={{ fontWeight: 600 }}>{c.t}</dt>
                  <dd style={{ margin: 0, color: "var(--ink-2)" }}>{c.d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="section" id="platforms">
          <div className="wrap">
            <div className="section-head">
              <div>
                <p className="label">Platforms</p>
                <h2 style={{ marginTop: 12 }}>Honest support labels.</h2>
              </div>
              <p>Each integration declares what it can read and write per category. Full and partial adapters write files directly, and guided ones prepare a kit you finish by hand because the platform offers no import.</p>
            </div>
            <div className="panel table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Platform</th>
                    <th scope="col">Support</th>
                    <th scope="col">What Nomad works with</th>
                  </tr>
                </thead>
                <tbody>
                  {direct.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{a.displayName}</td>
                      <td>
                        <Badge kind={a.support}>{a.support.toLowerCase()}</Badge>
                      </td>
                      <td className="why">{a.description}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ fontWeight: 600 }}>Hosted and frameworks</td>
                    <td>
                      <Badge kind="GUIDED">guided</Badge>
                    </td>
                    <td className="why">{guided.map((g) => g.displayName).join(", ")}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 16 }}>
              <Link href="/docs/adapters">See the full capability matrix</Link>
            </p>
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

        <section className="section">
          <div className="wrap split">
            <div>
              <p className="label">For developers</p>
              <h2 style={{ marginTop: 12 }}>The same engine everywhere.</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                The web app, the CLI and the MCP server share one migration engine. New platforms plug in through the adapter SDK and its contract tests.
              </p>
            </div>
            <pre className="code" aria-label="Command line example">
              <span className="c"># guided: pick an agent, pick where it goes</span>
              {"\nnpx thenomad\n\n"}
              <span className="c"># or in one line, with a short preview first</span>
              {"\nnpx thenomad move openclaw claude-code\n\n"}
              <span className="c"># save it to a file, open it anywhere</span>
              {"\nnpx thenomad move openclaw ./kestrel.nomad\nnpx thenomad move ./kestrel.nomad codex"}
            </pre>
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
                <Link href="/inspect" className="btn btn-ghost" style={{ color: "var(--paper)" }}>
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
