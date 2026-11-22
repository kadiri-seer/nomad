"use client";

import { useEffect, useState } from "react";
import { readMoves } from "@/lib/agent";

const REFRESH_MS = 120_000;

/** The last few things Nomad AI did, from the feed it publishes after each run. Hidden until there are some. */
export function AgentMoves() {
  const [moves, setMoves] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    let ctrl = new AbortController();
    const load = async () => {
      ctrl.abort();
      ctrl = new AbortController();
      try {
        const next = await readMoves(ctrl.signal);
        if (alive) setMoves(next);
      } catch {
        // The feed is optional: keep what is shown and try again later.
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

  if (!moves.length) return null;
  return (
    <section className="panel" aria-labelledby="agent-moves">
      <div className="panel-head">
        <h3 id="agent-moves" style={{ margin: 0 }}>
          Latest moves
        </h3>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          Updated after each run
        </span>
      </div>
      <ul className="ai-moves" aria-live="polite">
        {moves.map((m, i) => (
          <li key={`${i}-${m}`}>{m}</li>
        ))}
      </ul>
    </section>
  );
}
