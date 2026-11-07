"use client";

import { useState } from "react";
import { CATEGORY_LABELS } from "@nomad/compatibility";
import { COMPONENT_CATEGORIES } from "@nomad/schema";
import { api, useApi } from "@/lib/client";
import { CompatTable } from "@/components/CompatTable";
import { Badge, Notice, PageHead, Skeleton } from "@/components/ui";

const SHORT: Record<string, string> = { full: "Full", convert: "Converts", manual: "Manual", unsupported: "No" };

export default function CompatibilityPage() {
  const adapters = useApi<any[]>("adapters");
  const agents = useApi<any[]>("agents");
  const [agentId, setAgentId] = useState("");
  const [platform, setPlatform] = useState("claude-code");
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api("compatibility", { body: { source: { kind: "stored", agentId: agentId || agents.data?.[0]?.id }, platform } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Platform compatibility" sub="What each platform can store, and how a specific agent would fare." />
      {agents.data && agents.data.length > 0 && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-head">
            <h3>Check an agent</h3>
          </div>
          <div className="panel-body stack">
            <div className="grid-form">
              <label className="field">
                <span>Agent</span>
                <select className="select" value={agentId || agents.data[0].id} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.data.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Platform</span>
                <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  {(adapters.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" style={{ alignSelf: "end" }} disabled={busy} onClick={check}>
                {busy ? "Checking..." : "Check"}
              </button>
            </div>
            {error && <Notice tone="bad">{error}</Notice>}
            {report && (
              <>
                <p className="score">
                  <b>{report.score ?? "n/a"}</b>
                  <span className="muted">/100</span>
                </p>
                <p className="muted" style={{ fontSize: "0.86rem" }}>
                  {report.scoreExplanation}
                </p>
                {report.attention.length > 0 && <Notice tone="warn" title="Needs attention">{report.attention.join(" ")}</Notice>}
                <CompatTable report={report} />
              </>
            )}
          </div>
        </div>
      )}
      <h2 style={{ fontSize: "1.3rem", marginBottom: 12 }}>What each platform can store</h2>
      {adapters.loading && !adapters.data ? (
        <Skeleton rows={6} />
      ) : (
        <div className="panel table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Platform</th>
                {COMPONENT_CATEGORIES.filter((c) => c !== "project").map((c) => (
                  <th key={c} scope="col">
                    {CATEGORY_LABELS[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(adapters.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <strong>{a.displayName}</strong>
                    <br />
                    <Badge kind={a.support}>{a.support.toLowerCase()}</Badge>
                  </td>
                  {COMPONENT_CATEGORIES.filter((c) => c !== "project").map((c) => (
                    <td key={c} title={a.capabilities[c].notes}>
                      <Badge kind={a.capabilities[c].write}>{SHORT[a.capabilities[c].write]}</Badge>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
