"use client";

import { useEffect, useState } from "react";
import { AGENT_LIMITS, AGENT_WALLETS, addressUrl, fmt, readAgent, tradesToday, txUrl, usd, type AgentSnapshot } from "@/lib/agent";
import { Badge, Notice, Skeleton, formatDate } from "./ui";

const REFRESH_MS = 60_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="token-ca-copy"
      aria-label="Copy wallet address"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Nomad AI's wallets and activity, read live from Robinhood Chain and refreshed every minute. */
export function AgentLive() {
  const [data, setData] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let ctrl = new AbortController();
    const load = async () => {
      ctrl.abort();
      ctrl = new AbortController();
      try {
        const snap = await readAgent(ctrl.signal);
        if (alive) {
          setData(snap);
          setError(null);
        }
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setError("The explorer did not answer just now. Trying again in a minute.");
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(t);
    };
  }, []);

  if (!data && !error) return <Skeleton rows={5} />;

  const total = data ? data.wallets.reduce((s, w) => s + (w.ethUsd ?? 0) + w.holdings.reduce((h, x) => h + (x.usd ?? 0), 0), 0) : 0;
  const usdg = data ? data.wallets.flatMap((w) => w.holdings).filter((h) => h.symbol === "USDG").reduce((s, h) => s + h.amount, 0) : 0;
  const eth = data ? data.wallets.reduce((s, w) => s + w.eth, 0) : 0;
  const today = data ? tradesToday(data.activity) : 0;
  const last = data?.activity[0];

  return (
    <div className="stack" style={{ gap: 28 }}>
      {error && <Notice tone="warn">{error}</Notice>}

      {data && (
        <div className="stat-line" aria-live="polite">
          <div>
            <span className="label">Value now</span>
            <b>{usd(total)}</b>
          </div>
          <div>
            <span className="label">USDG</span>
            <b>{fmt(usdg)}</b>
          </div>
          <div>
            <span className="label">ETH</span>
            <b>{fmt(eth, 4)}</b>
          </div>
          <div>
            <span className="label">Trades today (UTC)</span>
            <b>
              {today} <span className="muted" style={{ fontSize: "1rem" }}>of {AGENT_LIMITS.tradesPerDay}</span>
            </b>
          </div>
          <div>
            <span className="label">Last on-chain activity</span>
            <b style={{ fontSize: "1rem", paddingTop: 8 }}>{last ? formatDate(last.time) : "None yet"}</b>
          </div>
        </div>
      )}

      <div className="grid-2">
        {AGENT_WALLETS.map((w) => {
          const state = data?.wallets.find((s) => s.wallet.id === w.id);
          return (
            <section key={w.id} className="panel" aria-labelledby={`wallet-${w.id}`}>
              <div className="panel-head">
                <h3 id={`wallet-${w.id}`} style={{ margin: 0 }}>
                  {w.name}
                </h3>
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  {w.role}
                </span>
              </div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                <div className="token-ca-row">
                  <code className="token-ca-addr" title={w.address}>
                    {w.address}
                  </code>
                  <CopyAddress address={w.address} />
                </div>
                <dl className="kv">
                  <dt>ETH</dt>
                  <dd>
                    {state ? fmt(state.eth, 4) : "…"}
                    {state?.ethUsd != null && <span className="muted"> ({usd(state.ethUsd)})</span>}
                  </dd>
                  {(state?.holdings ?? []).map((h) => (
                    <div key={h.symbol} style={{ display: "contents" }}>
                      <dt>{h.symbol}</dt>
                      <dd>
                        {fmt(h.amount)}
                        {h.usd != null && h.symbol !== "USDG" && <span className="muted"> ({usd(h.usd)})</span>}
                      </dd>
                    </div>
                  ))}
                  <dt>Identity</dt>
                  <dd>{w.detail}</dd>
                </dl>
                <div className="token-ca-links">
                  <a href={addressUrl(w.address)} target="_blank" rel="noopener noreferrer">
                    Explorer
                  </a>
                  {w.profile && (
                    <a href={w.profile} target="_blank" rel="noopener noreferrer">
                      Rushr profile
                    </a>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <section className="panel" aria-labelledby="agent-activity">
        <div className="panel-head">
          <h3 id="agent-activity" style={{ margin: 0 }}>
            On-chain activity
          </h3>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {data ? `Updated ${formatDate(data.fetchedAt)}` : ""}
          </span>
        </div>
        {data && data.activity.length === 0 ? (
          <div className="panel-body muted">Nothing on-chain yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Wallet</th>
                  <th>What happened</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {(data?.activity ?? []).slice(0, 25).map((a) => (
                  <tr key={`${a.walletId}-${a.hash}`}>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDate(a.time)}</td>
                    <td>{a.walletId === "oak" ? "Oak" : "Rushr"}</td>
                    <td>
                      {a.text}{" "}
                      {a.kind === "trade" && <Badge kind="info">Trade</Badge>}
                      {!a.ok && <Badge kind="bad">Failed</Badge>}
                    </td>
                    <td>
                      <a className="mono" href={txUrl(a.hash)} target="_blank" rel="noopener noreferrer">
                        {short(a.hash)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
        Read live from the public Robinhood Chain explorer, every minute. Prices are the explorer&apos;s.
      </p>
    </div>
  );
}
