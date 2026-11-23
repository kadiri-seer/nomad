"use client";

import { useMemo, useState } from "react";
import { ALL_INFOS, infoById } from "@nomad/adapters/catalog";
import { analyzeCompatibility, STATUS_LABELS } from "@nomad/compatibility";
import { sampleFrom } from "@/lib/sample";
import { Badge } from "./ui";

// Every platform Nomad can read an agent from. Hosted services and frameworks
// (guided) have nothing on disk to read, so they are destinations only.
const SOURCES = ALL_INFOS.filter((a) => a.support !== "GUIDED" && a.support !== "UNAVAILABLE").map((a) => a.id);

/**
 * Live preview on the home page. It runs the real compatibility engine in the
 * browser against a sample agent, so what you see is what the app reports.
 */
export function CompatDemo() {
  const [from, setFrom] = useState("openclaw");
  const [to, setTo] = useState("claude-code");
  const [all, setAll] = useState(false);
  const report = useMemo(() => {
    const src = infoById(from)!;
    return analyzeCompatibility(sampleFrom(from), src, infoById(to)!);
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
          <select
            className="select"
            value={from}
            onChange={(e) => {
              const next = e.target.value;
              setFrom(next);
              if (next === to) setTo(next === "claude-code" ? "codex" : "claude-code");
            }}
          >
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
        {(all ? rows : rows.slice(0, 5)).map((c) => (
          <li key={c.category} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
            <span>
              {c.label} <span className="muted">({c.items})</span>
            </span>
            <Badge kind={c.status}>{STATUS_LABELS[c.status]}</Badge>
          </li>
        ))}
      </ul>
      {rows.length > 5 && (
        <button type="button" className="btn btn-quiet" style={{ margin: "4px 18px 0", minHeight: 36, fontSize: "0.85rem" }} aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show ${rows.length - 5} more`}
        </button>
      )}
      <div className="panel-body" style={{ paddingTop: 8, fontSize: "0.88rem" }}>
        {report.attention.length ? (
          <p>
            <strong>Needs attention:</strong> {report.attention[0]}
          </p>
        ) : (
          <p className="muted">Everything this agent uses has a place at the destination.</p>
        )}
      </div>
    </div>
  );
}
