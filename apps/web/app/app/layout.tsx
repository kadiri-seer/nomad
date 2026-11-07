import Link from "next/link";
import { cookies } from "next/headers";
import { localEnabled, SESSION_COOKIE, tokenMatches } from "@/lib/server/local";
import { SiteFooter } from "@/components/SiteFooter";
import { AppNav } from "./AppNav";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Dashboard", template: "%s | Nomad" }, robots: { index: false } };

function LocalOnly({ expired }: { expired: boolean }) {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "72px 20px 96px" }}>
        <div className="split">
          <div>
            <p className="label">Local app</p>
            <h1 style={{ marginTop: 14, fontSize: "clamp(2rem,4vw,3rem)" }}>{expired ? "Your session has ended." : "The dashboard runs on your machine."}</h1>
            <p className="lede" style={{ marginTop: 16 }}>
              {expired
                ? "Open the link printed by nomad ui again. Sessions last until Nomad stops."
                : "Your agents live in local folders, so Nomad reads and writes them from your own computer. Nothing is uploaded, and this website never touches your files."}
            </p>
            <div className="row" style={{ marginTop: 28 }}>
              <Link href="/docs" className="btn">
                Install Nomad
              </Link>
              <Link href="/inspect" className="btn btn-quiet">
                Inspect a package here
              </Link>
            </div>
          </div>
          <div className="stack">
            <pre className="code" aria-label="Start the local app">
              <span className="c"># start the dashboard on 127.0.0.1</span>
              {"\nnomad ui"}
            </pre>
            <p className="muted">
              It opens in your browser with a one time session token. Requests from any other site or machine are refused.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!localEnabled()) return <LocalOnly expired={false} />;
  const jar = await cookies();
  if (!tokenMatches(jar.get(SESSION_COOKIE)?.value)) return <LocalOnly expired />;
  return (
    <div className="app-shell">
      <AppNav />
      <main id="main" className="app-main">
        {children}
      </main>
    </div>
  );
}
