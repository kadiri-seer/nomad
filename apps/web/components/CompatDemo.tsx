"use client";

import { useMemo, useState } from "react";
import { ALL_INFOS, infoById } from "@nomad/adapters/catalog";
import { analyzeCompatibility, STATUS_LABELS } from "@nomad/compatibility";
import { sampleAgent } from "@/lib/sample";
import { Badge } from "./ui";

const SOURCES = ["openclaw", "claude-code", "codex", "hermes"];

/**
 * Live preview on the home page. It runs the real compatibility engine in the
 * browser against a sample agent, so what you see is what the app reports.
 */
export function CompatDemo() {
  const [from, setFrom] = useState("openclaw");
  const [to, setTo] = useState("claude-code");
  const report = useMemo(() => {
    const src = infoById(from)!;
    return analyzeCompatibility(sampleAgent(from), src, infoById(to)!);
  }, [from, to]);
  const rows = report.categories.filter((c) => c.status !== "not-applicable");
  return (
    <div className="panel" style={{ color: "var(--ink)" }}>
      <div className="panel-head" style={{ flexWrap: "wrap" }}>
        <span className="label">Migration preview, sample agent</span>
        <span className="score" aria-live="polite">
          <b>{report.score}</b>
          <span className="muted">/100</span>
        </span>
      </div>
      <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, borderBottom: "1px solid var(--line)" }}>
        <label className="field">
          <span>From</span>
          <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
            {SOURCES.map((id) => (
              <option key={id} value={id}>
                {infoById(id)!.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>To</span>
          <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
            {ALL_INFOS.filter((a) => a.id !== from && a.id !== "generic").map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: "4px 18px 8px" }}>
        {rows.map((c) => (
          <li key={c.category} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
            <span>
              {c.label} <span className="muted">({c.items})</span>
            </span>
            <Badge kind={c.status}>{STATUS_LABELS[c.status]}</Badge>
          </li>
        ))}
      </ul>
      <div className="panel-body" style={{ paddingTop: 8, fontSize: "0.88rem" }}>
        {report.attention.length ? (
          <p>
            <strong>Needs attention:</strong> {report.attention[0]}
          </p>
        ) : (
          <p className="muted">Everything this agent uses has a place at the destination.</p>
        )}
        <p className="muted" style={{ marginTop: 6 }}>
          Support level for {infoById(to)!.displayName}: <Badge kind={infoById(to)!.support}>{infoById(to)!.support.toLowerCase()}</Badge>
        </p>
      </div>
    </div>
  );
}
