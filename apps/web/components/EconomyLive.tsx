"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { addressUrl, fmt, txUrl, usd } from "@/lib/agent";
import { BOUNTIES_PAGE, ECONOMY_WALLETS, readEconomy, tokenAmount, AGENTS_CONTRACT, type Economy, type Transfer } from "@/lib/economy";
import { Badge, Notice, Skeleton, formatDate } from "./ui";

const REFRESH_MS = 120_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function TxLink({ hash }: { hash: string }) {
  return (
    <a className="mono" href={txUrl(hash)} target="_blank" rel="noopener noreferrer">
      {short(hash)}
    </a>
  );
}

function TransferTable({ id, rows, who }: { id: string; rows: Transfer[]; who: "from" | "to" }) {
  return (
    <div className="table-wrap">
      <table className="data" id={id}>
        <thead>
          <tr>
            <th>When</th>
            <th>Amount</th>
            <th>{who === "from" ? "From" : "To"}</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.hash}-${t.amount}-${t[who]}`}>
              <td style={{ whiteSpace: "nowrap" }}>{formatDate(t.time)}</td>
              <td>{tokenAmount(t.amount, t.symbol)}</td>
              <td>
                <a className="mono" href={addressUrl(t[who])} target="_blank" rel="noopener noreferrer">
                  {short(t[who])}
                </a>
              </td>
              <td>
                <TxLink hash={t.hash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Head({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="panel-head">
      <h3 id={id} style={{ margin: 0 }}>
        {title}
      </h3>
      {note && (
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {note}
        </span>
      )}
    </div>
  );
}

/** Nomad's economy, read live from public sources and refreshed every two minutes. */
export function EconomyLive() {
  const [data, setData] = useState<Economy | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let ctrl = new AbortController();
    const load = async () => {
      ctrl.abort();
      ctrl = new AbortController();
      try {
        const next = await readEconomy(ctrl.signal);
        if (alive) {
          setData(next);
          setFailed(false);
        }
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setFailed(true);
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

  if (!data && !failed) return <Skeleton rows={6} />;
  if (!data) return <Notice tone="warn">The explorer did not answer just now. Trying again in two minutes.</Notice>;

  const treasury = data.wallets.find((w) => w.wallet.id === "treasury");
  const nomadBalance = (id: string) => data.wallets.find((w) => w.wallet.id === id)?.balances.find((b) => b.symbol === "$NOMAD")?.amount ?? 0;
  const c = data.costs;
  const groups: { key: "treasury" | "revenue" | "operating"; title: string }[] = [
    { key: "treasury", title: "Treasury" },
    { key: "revenue", title: "Revenue" },
    { key: "operating", title: "Operating" }
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      {data.errors.length > 0 && <Notice tone="warn">Not everything answered just now ({data.errors.join(", ")}). The rest is shown, and the page tries again in two minutes.</Notice>}

      <div className="stat-line" aria-live="polite">
        <div>
          <span className="label">Treasury</span>
          <b>{!treasury ? "Not read yet" : treasury.usd != null ? usd(treasury.usd) : tokenAmount(nomadBalance("treasury"))}</b>
        </div>
        <div>
          <span className="label">Received</span>
          <b>{data.revenue.received.length ? data.revenue.received.map((r) => `${fmt(r.amount)} ${r.symbol}`).join(", ") : "None yet"}</b>
        </div>
        <div>
          <span className="label">Nomad AI costs this month</span>
          <b>{c ? `$${c.thisMonth.totalUsd}` : "Not published yet"}</b>
        </div>
        <div>
          <span className="label">$NOMAD burned</span>
          <b>{data.burned.total != null ? fmt(data.burned.total) : "Unknown"}</b>
        </div>
      </div>

      <section className="panel" aria-labelledby="eco-wallets">
        <Head id="eco-wallets" title="Wallets" note={`Live from Robinhood Chain, updated ${formatDate(data.fetchedAt)}`} />
        <div className="panel-body stack" style={{ gap: 18 }}>
          {groups.map((g) => (
            <div key={g.key} className="stack" style={{ gap: 10 }}>
              <span className="label">{g.title}</span>
              <div className="grid-2">
                {ECONOMY_WALLETS.filter((w) => w.group === g.key).map((w) => {
                  const state = data.wallets.find((s) => s.wallet.id === w.id);
                  return (
                    <div key={w.id} className="eco-wallet">
                      <div className="eco-wallet-head">
                        <strong>{w.name}</strong>
                        <a className="mono" href={addressUrl(w.address)} target="_blank" rel="noopener noreferrer">
                          {short(w.address)}
                        </a>
                      </div>
                      <p className="muted eco-wallet-role">{w.role}</p>
                      <dl className="kv">
                        {(state?.balances ?? []).map((b) => (
                          <div key={`${b.symbol}-${b.token}`} style={{ display: "contents" }}>
                            <dt>{b.symbol}</dt>
                            <dd>
                              {fmt(b.amount)}
                              {b.usd != null && b.symbol !== "USDG" && <span className="muted"> ({usd(b.usd)})</span>}
                            </dd>
                          </div>
                        ))}
                        {!state && (
                          <>
                            <dt>Balance</dt>
                            <dd className="muted">Not read yet</dd>
                          </>
                        )}
                      </dl>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="eco-received">
        <Head id="eco-received" title="Received by the referral wallet" note="Every token that arrived, and who sent it" />
        <div className="panel-body stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            QHooks pays Nomad&apos;s share of its fees to this wallet. Anything else sent here shows too, with its sender, so each amount can be checked on the explorer.
          </p>
          {data.revenue.recent.length ? <TransferTable id="eco-received-list" rows={data.revenue.recent} who="from" /> : <p className="muted" style={{ margin: 0 }}>Nothing has arrived yet.</p>}
        </div>
      </section>

      <section className="panel" aria-labelledby="eco-costs">
        <Head id="eco-costs" title="Nomad AI's running costs" note={c ? `Published after each run, last ${formatDate(c.updated)}` : undefined} />
        {!c ? (
          <div className="panel-body muted">Nomad AI publishes its costs after its next run.</div>
        ) : (
          <div className="panel-body stack" style={{ gap: 16 }}>
            {c.budget && (
              <div className="eco-budget">
                <div className="eco-budget-label">
                  <span>
                    AI this month: <strong>${c.thisMonth.aiUsd}</strong> of its ${c.budget.monthlyUsd} AI budget
                  </span>
                  <span className="muted">{c.budget.usedPct}%</span>
                </div>
                <div className="eco-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, c.budget.usedPct)} aria-label="AI budget used this month">
                  <span style={{ width: `${Math.min(100, c.budget.usedPct)}%` }} />
                </div>
              </div>
            )}
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Cost</th>
                    <th>This month</th>
                    <th>Since it started</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>AI ({c.thisMonth.runs} runs this month)</td>
                    <td>${c.thisMonth.aiUsd}</td>
                    <td>${c.allTime.aiUsd}</td>
                  </tr>
                  <tr>
                    <td>OddsEngine safety checks ({c.thisMonth.oddsEngineChecks} this month)</td>
                    <td>${c.thisMonth.oddsEngineUsd}</td>
                    <td>${c.allTime.oddsEngineUsd}</td>
                  </tr>
                  <tr>
                    <td>Network fees ({c.thisMonth.upochTransactions} Upoch checkpoints and payments this month)</td>
                    <td>{c.thisMonth.networkFeesUsd != null ? `$${c.thisMonth.networkFeesUsd}` : `${c.thisMonth.networkFeesEth} ETH`}</td>
                    <td>{c.allTime.networkFeesUsd != null ? `$${c.allTime.networkFeesUsd}` : `${c.allTime.networkFeesEth} ETH`}</td>
                  </tr>
                  <tr>
                    <td>Payments for services ({c.thisMonth.payments} this month)</td>
                    <td>${c.thisMonth.paymentsUsd}</td>
                    <td>${c.allTime.paymentsUsd}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Total</strong>
                    </td>
                    <td>
                      <strong>${c.thisMonth.totalUsd}</strong>
                    </td>
                    <td>
                      <strong>${c.allTime.totalUsd}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
              Trades are not costs: this month it made {c.thisMonth.trades} trades worth ${c.thisMonth.tradedUsd} in all. Network fees in dollars use ETH&apos;s price at publishing time. Payments in tokens without a dollar price count as $0.00 here and are listed below.
            </p>
            {c.payments.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Paid</th>
                      <th>Amount</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.payments.map((p) => (
                      <tr key={`${p.time}-${p.name}`}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDate(p.time)}</td>
                        <td>{p.name}</td>
                        <td>
                          {p.amount} {p.token}
                        </td>
                        <td>{p.txHash ? <TxLink hash={p.txHash} /> : <span className="muted">Pending</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="eco-partners">
        <Head id="eco-partners" title="Services Nomad AI uses" note="Calls that ran, counted after each run" />
        {!c || c.partners.allTime.length === 0 ? (
          <div className="panel-body muted">Nomad AI publishes how often it uses each service after its next run.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>This month</th>
                  <th>Since counting began</th>
                </tr>
              </thead>
              <tbody>
                {c.partners.allTime.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{c.partners.thisMonth.find((x) => x.id === p.id)?.calls ?? 0}</td>
                    <td>{p.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="eco-bounties">
        <Head id="eco-bounties" title="Builder bounties" note="Paid in $NOMAD from the treasury" />
        <div className="panel-body stack" style={{ gap: 14 }}>
          {data.bounties === null ? (
            <p className="muted" style={{ margin: 0 }}>
              GitHub did not answer just now. <a href={BOUNTIES_PAGE}>See the bounties on GitHub</a>.
            </p>
          ) : data.bounties.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No bounty has been posted yet. Each integration that wins a <Link href="/vote">holder vote</Link> gets one.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Integration</th>
                    <th>Bounty</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bounties.map((b) => (
                    <tr key={b.number}>
                      <td>
                        <a href={b.url} target="_blank" rel="noopener noreferrer">
                          {b.integration ?? b.title}
                        </a>
                      </td>
                      <td>{b.amount ?? <span className="muted">Not stated</span>}</td>
                      <td>{b.state === "done" ? <Badge kind="ok">Closed</Badge> : <Badge kind="info">Open</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.payouts.length > 0 && (
            <>
              <span className="label">$NOMAD sent from the treasury</span>
              <TransferTable id="eco-payouts" rows={data.payouts} who="to" />
            </>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="eco-burns">
        <Head id="eco-burns" title="Buybacks and burns" note="Only when finances permit; none are promised" />
        <div className="panel-body stack" style={{ gap: 14 }}>
          <p className="muted" style={{ margin: 0 }}>
            Burned $NOMAD is sent to the dead address, where no one can move it again. {data.burned.total != null && <>It holds {tokenAmount(data.burned.total)} now.</>}
          </p>
          {data.buybacks.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Spent</th>
                    <th>Bought</th>
                    <th>Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buybacks.map((b) => (
                    <tr key={b.tx}>
                      <td style={{ whiteSpace: "nowrap" }}>{b.date}</td>
                      <td>{b.spent}</td>
                      <td>{b.bought}</td>
                      <td>
                        <TxLink hash={b.tx} />
                        {b.burnTx && (
                          <>
                            {" "}
                            and burn <TxLink hash={b.burnTx} />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.burned.recent.length > 0 ? (
            <>
              <span className="label">Recent burns</span>
              <TransferTable id="eco-burn-list" rows={data.burned.recent} who="from" />
            </>
          ) : (
            data.buybacks.length === 0 && (
              <p className="muted" style={{ margin: 0 }}>
                No buyback or burn yet.
              </p>
            )
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="eco-agents">
        <Head id="eco-agents" title="Minted agents" />
        <div className="panel-body stack" style={{ gap: 10 }}>
          {!AGENTS_CONTRACT ? (
            <p className="muted" style={{ margin: 0 }}>
              Minting is not open yet. When it opens, mint fees and creator fees from <Link href="/agents">minted agents</Link> show here.
            </p>
          ) : !data.agents ? (
            <p className="muted" style={{ margin: 0 }}>
              The explorer did not answer for minted agents just now.
            </p>
          ) : (
            <dl className="kv">
              <dt>Agents</dt>
              <dd>
                <Link href="/agents">{data.agents.agents.length}</Link>
              </dd>
              <dt>Burned</dt>
              <dd>{tokenAmount(data.agents.burned)}</dd>
              <dt>To treasury</dt>
              <dd>{tokenAmount(data.agents.toTreasury)}</dd>
              <dt>To creators</dt>
              <dd>{tokenAmount(data.agents.toCreators)}</dd>
            </dl>
          )}
        </div>
      </section>
    </div>
  );
}
