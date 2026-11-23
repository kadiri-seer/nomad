"use client";

/**
 * Nomad accounts: sign in with Google, hold $NOMAD and USDG, create agents and add credits. Each money action is shown
 * on a confirm sheet first (what it costs in $NOMAD, where it goes) and sent as one operation from the person's smart
 * account, gas paid through NomadPaymaster. Mirrors the "Nomad agents: home and create agent" design.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, parseUnits, type Address } from "viem";
import { PRIVY_APP_ID, PAYMASTER, NOMAD, USDG } from "@/lib/accounts/chain";
import { AGENTS_CONTRACT } from "@/lib/economy";
import { Mark, Wordmark } from "@/components/Logo";
import {
  accountClient,
  agentPackage,
  balances,
  buyNomadCalls,
  fmtNomad,
  fmtUsdg,
  mintCalls,
  mintFee,
  nomadForUsd,
  ownerFromProvider,
  robinhood,
  send,
  stoaQuote,
  topUpNomadCalls,
  topUpUsdgCalls,
  type Call
} from "@/lib/accounts/client";

type Client = Awaited<ReturnType<typeof accountClient>>;
type Confirm = {
  title: string;
  amount: string;
  amountNote: string;
  rows: [string, string][];
  note?: string;
  build: () => Promise<Call[]>;
  after?: (txHash: string) => Promise<string | void>;
  done: { title: string; body: string };
};

export function AccountApp() {
  // Opens only once the paymaster is live too: without it, funds sent to an account could not be moved without ETH.
  if (!PRIVY_APP_ID || !PAYMASTER) {
    return (
      <main id="main" className="acct-wrap">
        <div className="acct-card">
          <p className="label">Nomad accounts</p>
          <h1 className="acct-h1">Opening soon</h1>
          <p className="acct-muted">Sign in with Google, create an agent with $NOMAD and let it run on its own. This page opens once the last pieces are switched on.</p>
          <Link href="/ai" className="btn" style={{ marginTop: 16 }}>
            See Nomad AI at work
          </Link>
        </div>
      </main>
    );
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google"],
        appearance: { theme: "light", accentColor: "#1d5cff", landingHeader: "Sign in to Nomad", showWalletLoginFirst: false },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        defaultChain: robinhood,
        supportedChains: [robinhood]
      }}
    >
      <Account />
    </PrivyProvider>
  );
}

function Account() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy"), [wallets]);

  useEffect(() => {
    let off = false;
    (async () => {
      if (!embedded) return;
      try {
        const provider = await embedded.getEthereumProvider();
        const c = await accountClient(ownerFromProvider(embedded.address as Address, provider as never));
        if (!off) setClient(c);
      } catch {
        if (!off) setError("Your account could not be opened. Reload the page to try again.");
      }
    })();
    return () => {
      off = true;
    };
  }, [embedded]);

  if (!ready) return <Shell><p className="acct-muted">Loading</p></Shell>;
  if (!authenticated) {
    return (
      <Shell>
        <div className="acct-card">
          <h1 className="acct-h1">Create agents that run on their own.</h1>
          <p className="acct-muted">Sign in with Google. Your account on Robinhood Chain is made for you: no wallet app, no seed phrase, no ETH.</p>
          <button type="button" className="acct-primary" onClick={() => login()}>
            Continue with Google
          </button>
          <p className="acct-small">Agents on Nomad are created and paid for with $NOMAD.</p>
        </div>
      </Shell>
    );
  }
  if (error) return <Shell><p className="acct-error">{error}</p></Shell>;
  if (!client) return <Shell><p className="acct-muted">Opening your account</p></Shell>;
  return <Home client={client} onSignOut={() => logout()} />;
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <main id="main" className="acct-wrap">
      <Toast />
      <div className="acct-top">
        <Link href="/" className="acct-logo" aria-label="Nomad home">
          <Mark size={22} />
          <Wordmark height={12} />
        </Link>
        {right}
      </div>
      {children}
    </main>
  );
}

function Home({ client, onSignOut }: { client: Client; onSignOut: () => void }) {
  const address = client.account.address as Address;
  const [bal, setBal] = useState<{ nomad: bigint; usdg: bigint } | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const [price, setPrice] = useState<number | null>(null); // dollars per 1 $NOMAD
  const [view, setView] = useState<"home" | "create">("home");
  const [sheet, setSheet] = useState<"funds" | "credits" | "buy" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const refresh = useCallback(async () => {
    setBal(await balances(address));
    try {
      const r = await fetch(`/api/account/credits?account=${address}`, { cache: "no-store" });
      const j = await r.json();
      setCredits(r.ok ? j.availableUsd : null);
    } catch {
      setCredits(null);
    }
  }, [address]);

  useEffect(() => {
    refresh();
    nomadForUsd(1)
      .then((n) => setPrice(n > 0n ? 1 / Number(formatUnits(n, 18)) : null))
      .catch(() => setPrice(null));
  }, [refresh]);

  const usdOf = (n: bigint) => (price ? `$${(Number(formatUnits(n, 18)) * price).toFixed(2)}` : "");

  return (
    <Shell right={<button type="button" className="acct-quiet" onClick={onSignOut}>Sign out</button>}>
      {view === "create" ? (
        <Create client={client} bal={bal} usdOf={usdOf} onBack={() => setView("home")} onConfirm={setConfirm} />
      ) : (
        <div className="acct-stack">
          <section className="acct-balance" aria-label="Balance">
            <div className="acct-label-dark">Your balance</div>
            <div className="acct-big">
              <span>{bal ? fmtNomad(bal.nomad) : "..."}</span>
              <span className="acct-ticker">$NOMAD</span>
            </div>
            <div className="acct-sub-dark">
              {bal ? `${usdOf(bal.nomad)}${usdOf(bal.nomad) ? " · " : ""}USDG ${fmtUsdg(bal.usdg)}` : ""}
            </div>
            <div className="acct-row">
              <button type="button" className="acct-lime" onClick={() => setSheet("buy")}>Get $NOMAD</button>
              <button type="button" className="acct-outline-dark" onClick={() => setSheet("funds")}>Add funds</button>
            </div>
          </section>
          <p className="acct-small" style={{ textAlign: "center" }}>Agents on Nomad are created and paid for with $NOMAD.</p>

          <section className="acct-card">
            <span className="acct-chip">NEXT STEP</span>
            <h2 className="acct-h2">Create your first agent</h2>
            <p className="acct-body">Name it, pick what it does and set its limits. It runs by itself in Nomad&apos;s cloud.</p>
            <button type="button" className="acct-primary" onClick={() => setView("create")} disabled={!AGENTS_CONTRACT}>
              {AGENTS_CONTRACT ? "Create agent" : "Creating agents opens soon"}
            </button>
          </section>

          <section className="acct-card">
            <div className="acct-between">
              <h2 className="acct-h3">Credits</h2>
              <strong>{credits === null ? "..." : `$${credits}`}</strong>
            </div>
            <p className="acct-body">Credits pay for your agents&apos; thinking and their network fees.</p>
            <button type="button" className="acct-secondary" onClick={() => setSheet("credits")}>Add credits</button>
          </section>
        </div>
      )}

      {sheet === "funds" && (
        <Sheet title="Add funds" onClose={() => setSheet(null)}>
          <p className="acct-body">Send $NOMAD or USDG on Robinhood Chain to your account:</p>
          <code className="acct-address">{address}</code>
          <button type="button" className="acct-secondary" onClick={() => navigator.clipboard?.writeText(address)}>Copy address</button>
          <p className="acct-small">Only Robinhood Chain. Other networks or tokens sent here may be lost.</p>
        </Sheet>
      )}

      {sheet === "buy" && (
        <BuyNomad
          usdg={bal?.usdg ?? 0n}
          onClose={() => setSheet(null)}
          onConfirm={(usdg, out) => {
            setSheet(null);
            setConfirm({
              title: "Get $NOMAD",
              amount: `+${fmtNomad(out)} $NOMAD`,
              amountNote: `for ${fmtUsdg(usdg)} USDG`,
              rows: [["Swap through", "Stoa"], ["Network fee", "Included"], ["To", "Your account"]],
              build: async () => (await buyNomadCalls(usdg, address)).calls,
              done: { title: "$NOMAD added", body: `${fmtNomad(out)} $NOMAD is in your account.` }
            });
          }}
        />
      )}

      {sheet === "credits" && (
        <AddCredits
          bal={bal}
          onClose={() => setSheet(null)}
          onConfirm={(c) => {
            setSheet(null);
            setConfirm(c);
          }}
          address={address}
        />
      )}

      {confirm && (
        <Approve
          client={client}
          confirm={confirm}
          onClose={() => {
            setConfirm(null);
            refresh();
          }}
          onHome={() => {
            setConfirm(null);
            setView("home");
            refresh();
          }}
        />
      )}
    </Shell>
  );
}

function Create({ client, bal, usdOf, onBack, onConfirm }: { client: Client; bal: { nomad: bigint; usdg: bigint } | null; usdOf: (n: bigint) => string; onBack: () => void; onConfirm: (c: Confirm) => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<"trader" | "blank">("trader");
  const [instructions, setInstructions] = useState("");
  const [perTrade, setPerTrade] = useState("0.30");
  const [perDay, setPerDay] = useState(3);
  const [fee, setFee] = useState<bigint | null>(null);
  const agents = AGENTS_CONTRACT as Address;
  useEffect(() => {
    mintFee(agents).then(setFee).catch(() => setFee(null));
  }, [agents]);
  const short = fee !== null && bal ? (bal.nomad >= fee ? 0n : fee - bal.nomad) : 0n;
  const ok = name.trim().length > 0 && name.trim().length <= 64 && fee !== null && (template === "trader" || instructions.trim().length > 0);

  const go = async () => {
    if (!fee || !bal) return;
    const pkg = agentPackage({ name: name.trim(), template, perTradeUsd: perTrade, tradesPerDay: perDay, ...(template === "blank" ? { instructions: instructions.trim() } : {}) });
    let topUp: { usdg: bigint; calls: Call[] } | null = null;
    if (short > 0n) {
      // Buy what is missing with USDG, with a 3% cushion for the price moving.
      const perUsdg = await nomadForUsd(1);
      const usdg = (short * 10n ** 6n * 103n) / (perUsdg * 100n) + 1n;
      if (usdg > bal.usdg) throw new Error("Not enough $NOMAD or USDG to create the agent.");
      topUp = { usdg, calls: (await stoaQuote(USDG, NOMAD, usdg, client.account.address as Address)).calls };
    }
    onConfirm({
      title: `Approve: create agent "${name.trim()}"`,
      amount: `-${fmtNomad(fee)} $NOMAD`,
      amountNote: usdOf(fee),
      rows: [
        ...(topUp ? ([["First, swap", `${fmtUsdg(topUp.usdg)} USDG for the missing $NOMAD`]] as [string, string][]) : []),
        ["Burned", `${fmtNomad(fee / 2n)} $NOMAD`],
        ["To Nomad's treasury", `${fmtNomad(fee - fee / 2n)} $NOMAD`],
        ["Network fee", "Included"]
      ],
      build: async () => [...(topUp?.calls ?? []), ...mintCalls(agents, fee, name.trim(), pkg.hash)],
      done: { title: `${name.trim()} is created`, body: `${fmtNomad(fee)} $NOMAD paid, ${fmtNomad(fee / 2n)} burned. Add credits so it can start running.` }
    });
  };

  return (
    <div className="acct-stack">
      <div className="acct-row" style={{ alignItems: "center" }}>
        <button type="button" className="acct-back" aria-label="Back to home" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <h1 className="acct-h1" style={{ margin: 0 }}>Create agent</h1>
      </div>
      <label className="acct-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Scout" />
      </label>
      <fieldset className="acct-fieldset">
        <legend>What it does</legend>
        {(
          [
            ["trader", "Trader, like Nomad AI", "Looks at the market, checks tokens for safety, makes small trades."],
            ["blank", "Start from scratch", "Write its instructions yourself."]
          ] as const
        ).map(([id, title, body]) => (
          <button key={id} type="button" className="acct-option" aria-pressed={template === id} onClick={() => setTemplate(id)}>
            <span>
              <strong>{title}</strong>
              <span className="acct-small">{body}</span>
            </span>
            <span className="acct-dot" aria-hidden="true" />
          </button>
        ))}
      </fieldset>
      {template === "blank" && (
        <label className="acct-field">
          <span>Instructions</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={4000} />
        </label>
      )}
      <div className="acct-grid2">
        <label className="acct-field">
          <span>Per trade, at most (USDG)</span>
          <input value={perTrade} inputMode="decimal" onChange={(e) => setPerTrade(e.target.value.replace(/[^0-9.]/g, "").slice(0, 6))} />
        </label>
        <label className="acct-field">
          <span>Trades a day, at most</span>
          <input value={perDay} inputMode="numeric" onChange={(e) => setPerDay(Math.max(1, Math.min(10, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
        </label>
      </div>
      <section className="acct-card">
        <div className="acct-between">
          <span>Creating an agent</span>
          <strong>{fee === null ? "..." : `${fmtNomad(fee)} $NOMAD`}</strong>
        </div>
        <p className="acct-small">{fee !== null && usdOf(fee) ? `${usdOf(fee)}, once. ` : ""}Network fee included. Half is burned, half goes to Nomad&apos;s treasury.</p>
        {fee !== null && bal && short > 0n && <p className="acct-warn">You have {fmtNomad(bal.nomad)} $NOMAD. The missing {fmtNomad(short)} will be bought with USDG in this step.</p>}
        {fee !== null && bal && short === 0n && <p className="acct-ok">You have {fmtNomad(bal.nomad)} $NOMAD. Enough to create it.</p>}
      </section>
      <button type="button" className="acct-primary" disabled={!ok} onClick={() => go().catch((e) => alertSoft(e))}>
        {fee === null ? "Create agent" : `Create agent · ${fmtNomad(fee)} $NOMAD`}
      </button>
      <p className="acct-small" style={{ textAlign: "center" }}>One approval. Nothing else to sign.</p>
    </div>
  );
}

function BuyNomad({ usdg, onClose, onConfirm }: { usdg: bigint; onClose: () => void; onConfirm: (usdg: bigint, out: bigint) => void }) {
  const [amount, setAmount] = useState("5");
  const [out, setOut] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const value = (() => {
    try {
      return parseUnits(amount || "0", 6);
    } catch {
      return 0n;
    }
  })();
  useEffect(() => {
    setOut(null);
    setErr(null);
    if (value <= 0n) return;
    const t = setTimeout(() => {
      stoaQuote(USDG, NOMAD, value)
        .then((q) => setOut(q.amountOut))
        .catch((e) => setErr(e.message));
    }, 400);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <Sheet title="Get $NOMAD" onClose={onClose}>
      <label className="acct-field">
        <span>Pay with USDG (you have {fmtUsdg(usdg)})</span>
        <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, "").slice(0, 10))} />
      </label>
      <p className="acct-body">{err ?? (out !== null ? `You get about ${fmtNomad(out)} $NOMAD.` : value > 0n ? "Getting a price" : "")}</p>
      <button type="button" className="acct-primary" disabled={!out || value > usdg} onClick={() => out && onConfirm(value, out)}>
        {value > usdg ? "Not enough USDG" : "Continue"}
      </button>
      <p className="acct-small">Swapped through Stoa on Robinhood Chain. Prices move; the amount is checked again when you approve.</p>
    </Sheet>
  );
}

function AddCredits({ bal, address, onClose, onConfirm }: { bal: { nomad: bigint; usdg: bigint } | null; address: Address; onClose: () => void; onConfirm: (c: Confirm) => void }) {
  const [usd, setUsd] = useState("5");
  const [busy, setBusy] = useState(false);
  const claim = async (txHash: string) => {
    const r = await fetch("/api/account/credits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: address, txHash }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "The top-up could not be counted yet.");
    return `$${j.addedUsd} added. Credits: $${j.availableUsd}.`;
  };
  const dollars = Math.max(1, Math.min(100, Number(usd) || 0));
  const payNomad = async () => {
    setBusy(true);
    try {
      const nomad = await nomadForUsd(dollars);
      onConfirm({
        title: "Add credits with $NOMAD",
        amount: `-${fmtNomad(nomad)} $NOMAD`,
        amountNote: `$${(dollars * 1.1).toFixed(2)} of credits (+10%)`,
        rows: [["Swapped to USDG for", "Nomad's treasury"], ["Network fee", "Included"], ["Credits", "Can't be withdrawn"]],
        build: () => topUpNomadCalls(nomad),
        after: claim,
        done: { title: "Credits added", body: "" }
      });
    } finally {
      setBusy(false);
    }
  };
  const payUsdg = () => {
    const amount = parseUnits(dollars.toFixed(2), 6);
    onConfirm({
      title: "Add credits with USDG",
      amount: `-${fmtUsdg(amount)} USDG`,
      amountNote: `$${dollars.toFixed(2)} of credits`,
      rows: [["To", "Nomad's treasury"], ["Network fee", "Included"], ["Credits", "Can't be withdrawn"]],
      build: async () => topUpUsdgCalls(amount),
      after: claim,
      done: { title: "Credits added", body: "" }
    });
  };
  return (
    <Sheet title="Add credits" onClose={onClose}>
      <label className="acct-field">
        <span>Amount, in dollars (1 to 100)</span>
        <input value={usd} inputMode="decimal" onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, "").slice(0, 6))} />
      </label>
      <button type="button" className="acct-primary" disabled={busy || !bal} onClick={() => payNomad().catch((e) => alertSoft(e))}>
        Pay with $NOMAD (+10% credits)
      </button>
      <button type="button" className="acct-secondary" disabled={!bal || (bal && bal.usdg < parseUnits(dollars.toFixed(2), 6))} onClick={payUsdg}>
        Pay with USDG
      </button>
      <p className="acct-small">Credits pay for your agents&apos; thinking and their network fees. They are prepaid and can&apos;t be withdrawn.</p>
    </Sheet>
  );
}

function Approve({ client, confirm, onClose, onHome }: { client: Client; confirm: Confirm; onClose: () => void; onHome: () => void }) {
  const [state, setState] = useState<"ask" | "sending" | "done" | "error">("ask");
  const [message, setMessage] = useState("");
  const [tx, setTx] = useState<string | null>(null);
  const approve = async () => {
    setState("sending");
    try {
      const calls = await confirm.build();
      const { txHash } = await send(client, calls);
      setTx(txHash);
      let extra = "";
      if (confirm.after) {
        for (let i = 0; i < 5; i++) {
          try {
            extra = (await confirm.after(txHash)) ?? "";
            break;
          } catch (e) {
            if (i === 4) extra = (e as Error).message;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
      setMessage(extra || confirm.done.body);
      setState("done");
    } catch (e) {
      setMessage((e as Error).message?.slice(0, 200) || "It did not go through. Nothing was charged.");
      setState("error");
    }
  };
  const address = client.account.address;
  return (
    <div className="acct-overlay" role="presentation">
      <section className="acct-sheet" role="dialog" aria-modal="true" aria-labelledby="approve-title">
        <div className="acct-handle" aria-hidden="true" />
        {state === "done" ? (
          <div className="acct-done">
            <div className="acct-check" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </div>
            <h2 id="approve-title" className="acct-h2">{confirm.done.title}</h2>
            <p className="acct-body">{message}</p>
            {tx && (
              <a href={`https://robinhoodchain.blockscout.com/tx/${tx}`} target="_blank" rel="noopener noreferrer">
                View on the explorer
              </a>
            )}
            <button type="button" className="acct-primary" onClick={onHome}>Back to home</button>
          </div>
        ) : (
          <>
            <div className="acct-between">
              <div className="acct-row" style={{ alignItems: "center" }}>
                <span className="acct-app-icon"><Mark size={14} /></span>
                <span>
                  <strong style={{ display: "block", fontSize: 14 }}>Nomad</strong>
                  <span className="acct-mono">www.thenomad.website</span>
                </span>
              </div>
              <span className="acct-pill"><span className="acct-green-dot" aria-hidden="true" />Robinhood Chain</span>
            </div>
            <h2 id="approve-title" className="acct-label-light">{confirm.title}</h2>
            <div>
              <div className="acct-amount">{confirm.amount}</div>
              <div className="acct-muted">{confirm.amountNote}</div>
            </div>
            <dl className="acct-rows">
              {[...confirm.rows, ["From", `Your account ${address.slice(0, 6)}...${address.slice(-4)}`] as [string, string]].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {state === "error" && <p className="acct-error">{message}</p>}
            <div className="acct-grid2">
              <button type="button" className="acct-secondary" onClick={onClose} disabled={state === "sending"}>Cancel</button>
              <button type="button" className="acct-primary" onClick={approve} disabled={state === "sending"}>
                {state === "sending" ? "Approving" : state === "error" ? "Try again" : "Approve"}
              </button>
            </div>
            <p className="acct-small" style={{ textAlign: "center" }}>Signed in with Google · your key never leaves your account</p>
          </>
        )}
      </section>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="acct-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="acct-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="acct-handle" aria-hidden="true" />
        <div className="acct-between">
          <h2 className="acct-h2" style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="acct-quiet" onClick={onClose}>Close</button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** Shows a short error at the top of the page for a few seconds (no browser dialogs). */
function alertSoft(e: unknown) {
  window.dispatchEvent(new CustomEvent("nomad-account-error", { detail: (e as Error)?.message ?? "Something went wrong. Nothing was sent." }));
}

function Toast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = (e: Event) => {
      setMsg(String((e as CustomEvent).detail).slice(0, 200));
      clearTimeout(t);
      t = setTimeout(() => setMsg(null), 6000);
    };
    window.addEventListener("nomad-account-error", on);
    return () => window.removeEventListener("nomad-account-error", on);
  }, []);
  return msg ? (
    <p className="acct-toast" role="alert">
      {msg}
    </p>
  ) : null;
}
