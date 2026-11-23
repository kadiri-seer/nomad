"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ECONOMY_FEED_URL, parseCosts, type Costs } from "@/lib/economy";

/** Nomad AI's running costs this month, from the feed it publishes after each run. Hidden until there is one. */
export function AgentCosts() {
  const [costs, setCosts] = useState<Costs | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(ECONOMY_FEED_URL, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setCosts(j ? parseCosts(j) : null))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  if (!costs) return null;
  const m = costs.thisMonth;
  return (
    <section className="panel" aria-labelledby="agent-costs">
      <div className="panel-head">
        <h3 id="agent-costs" style={{ margin: 0 }}>
          Running costs
        </h3>
        <Link href="/economy" style={{ fontSize: "0.85rem" }}>
          See the economy
        </Link>
      </div>
      <div className="panel-body">
        <dl className="kv">
          <dt>This month</dt>
          <dd>${m.totalUsd}</dd>
          {costs.budget && (
            <>
              <dt>AI budget</dt>
              <dd>
                ${m.aiUsd} of ${costs.budget.monthlyUsd} used this month
              </dd>
            </>
          )}
          <dt>Made of</dt>
          <dd>
            AI ${m.aiUsd}, OddsEngine checks ${m.oddsEngineUsd}, network fees {m.networkFeesUsd != null ? `$${m.networkFeesUsd}` : `${m.networkFeesEth} ETH`}
            {m.payments > 0 && `, payments $${m.paymentsUsd}`}
          </dd>
        </dl>
      </div>
    </section>
  );
}
