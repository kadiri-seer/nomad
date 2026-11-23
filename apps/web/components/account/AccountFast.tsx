"use client";

/**
 * The account page's first paint: drawn at once with no wallet code at all, while the sign-in library and the
 * account code (several megabytes) load in the background. A returning person sees their last balances and agents
 * straight away; a new visitor sees the sign-in card, and a tap on it is kept until sign-in is ready.
 */
import Link from "next/link";
import { lazy, Suspense, useEffect, useState } from "react";
import { Mark, Wordmark } from "@/components/Logo";
import { readSnapshot, type Snapshot } from "./snapshot";

const Full = lazy(() => import("./AccountApp").then((m) => ({ default: m.AccountApp })));

export function AccountFast({ enabled }: { enabled: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [wantLogin, setWantLogin] = useState(false);
  useEffect(() => {
    setSnap(readSnapshot());
    setMounted(true);
  }, []);

  const quick = <QuickView enabled={enabled} snap={snap} waiting={wantLogin} onLogin={() => setWantLogin(true)} />;
  if (!mounted || !enabled) return quick;
  return (
    <Suspense fallback={quick}>
      <Full placeholder={quick} autoLogin={wantLogin} />
    </Suspense>
  );
}

function QuickView({ enabled, snap, waiting, onLogin }: { enabled: boolean; snap: Snapshot | null; waiting: boolean; onLogin: () => void }) {
  return (
    <main id="main" className="acct-wrap">
      <div className="acct-top">
        <Link href="/" className="acct-logo" aria-label="Nomad home">
          <Mark size={22} />
          <Wordmark height={12} />
        </Link>
      </div>
      {!enabled ? (
        <div className="acct-card">
          <p className="label">Nomad accounts</p>
          <h1 className="acct-h1">Opening soon</h1>
          <p className="acct-muted">Sign in with Google, create an agent with $NOMAD and let it run on its own.</p>
          <Link href="/ai" className="btn" style={{ marginTop: 16 }}>
            See Nomad AI at work
          </Link>
        </div>
      ) : snap ? (
        <div className="acct-stack" aria-busy="true">
          <section className="acct-balance" aria-label="Balance">
            <div className="acct-label-dark">Your balance</div>
            <div className="acct-big">
              <span>{snap.nomad}</span>
              <span className="acct-ticker">$NOMAD</span>
            </div>
            <div className="acct-sub-dark">{`${snap.usd}${snap.usd ? " · " : ""}USDG ${snap.usdg}`}</div>
            <div className="acct-row">
              <button type="button" className="acct-lime" disabled>Get $NOMAD</button>
              <button type="button" className="acct-outline-dark" disabled>Add funds</button>
            </div>
          </section>
          <p className="acct-small" style={{ textAlign: "center" }}>Opening your account…</p>
          {snap.agents.length > 0 && (
            <section className="acct-card">
              <h2 className="acct-h3">Your agents</h2>
              {snap.agents.map((a) => (
                <div key={a.name} className="acct-between">
                  <span>{a.name}</span>
                  <span className="acct-small">{a.status === "active" ? "Running" : "Paused"}</span>
                </div>
              ))}
            </section>
          )}
          <section className="acct-card">
            <div className="acct-between">
              <h2 className="acct-h3">Credits</h2>
              <strong>{snap.credits === null ? "..." : `$${snap.credits}`}</strong>
            </div>
          </section>
        </div>
      ) : (
        <div className="acct-card">
          <h1 className="acct-h1">Create agents that run on their own.</h1>
          <p className="acct-muted">Sign in with Google. Your account on Robinhood Chain is made for you: no wallet app, no seed phrase, no ETH.</p>
          <button type="button" className="acct-primary" onClick={onLogin} disabled={waiting}>
            {waiting ? "Opening Google sign-in…" : "Continue with Google"}
          </button>
          <p className="acct-small">Agents on Nomad are created and paid for with $NOMAD.</p>
        </div>
      )}
    </main>
  );
}
