"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { COMPONENT_CATEGORIES, type ComponentCategory } from "@nomad/schema";
import { CATEGORY_LABELS } from "@nomad/compatibility";
import { api, useApi } from "@/lib/client";
import { Empty, Notice, PageHead, Skeleton } from "@/components/ui";

function ExportForm() {
  const params = useSearchParams();
  const agents = useApi<any[]>("agents");
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  const [version, setVersion] = useState<number | "">("");
  const [components, setComponents] = useState<Set<ComponentCategory>>(new Set(COMPONENT_CATEGORIES));
  const [includeFiles, setIncludeFiles] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [format, setFormat] = useState<"agentpack" | "interchange">("agentpack");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId && agents.data?.length) setAgentId(agents.data[0].id);
  }, [agents.data, agentId]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api("export", { body: { source: { kind: "stored", agentId, version: version || undefined }, includeFiles, includeSecrets, components: [...components], format } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (agents.loading && !agents.data) return <Skeleton rows={4} />;
  if (!agents.data?.length) return <Empty title="Nothing to export yet">Add an agent to your library first.</Empty>;
  const selected = agents.data.find((a) => a.id === agentId);

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="grid-form">
        <label className="field">
          <span>Agent</span>
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.data.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Version</span>
          <input className="input" type="number" min={1} max={selected?.currentVersion} placeholder={`Latest (v${selected?.currentVersion ?? 1})`} value={version} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : "")} />
        </label>
      </div>
      <label className="field" style={{ maxWidth: 420 }}>
        <span>Format</span>
        <select className="select" value={format} onChange={(e) => setFormat(e.target.value as "agentpack" | "interchange")}>
          <option value="agentpack">.agentpack (complete, with integrity hashes)</option>
          <option value="interchange">.jetpack (interchange archive for other tools)</option>
        </select>
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Include</legend>
        <div className="grid-form" style={{ gap: 0 }}>
          {COMPONENT_CATEGORIES.filter((c) => c !== "identity").map((c) => (
            <label key={c} className="check">
              <input
                type="checkbox"
                checked={components.has(c)}
                onChange={(e) => {
                  const n = new Set(components);
                  if (e.target.checked) n.add(c);
                  else n.delete(c);
                  n.add("identity");
                  setComponents(n);
                }}
              />
              <span>{CATEGORY_LABELS[c]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
        <span>
          Include knowledge and other files
          <br />
          <small className="muted">Only files Nomad already read with the agent.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
        <span>
          Keep secret values
          <br />
          <small className="muted">Not recommended. The library stores agents with secrets already redacted, so this only matters for values that were never detected.</small>
        </span>
      </label>
      {includeSecrets && <Notice tone="warn" title="Share this package carefully">Anyone with the file could read any credential left in it.</Notice>}
      <div className="row">
        <button className="btn" disabled={busy || !agentId} onClick={run}>
          {busy ? "Exporting..." : "Export package"}
        </button>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {result && (
        <Notice tone="ok" title={`${result.file} is ready`}>
          {(result.size / 1024).toFixed(1)} KB. {result.redacted ? `${result.redacted} secret value(s) redacted. ` : ""}
          {result.references ? `${result.references} credential(s) kept as references. ` : ""}
          {result.removedFiles.length ? `Left out: ${result.removedFiles.join(", ")}.` : ""}
          {result.notIncluded?.length ? ` Not representable in this format: ${result.notIncluded.join(", ")}.` : ""}
          <div className="row" style={{ marginTop: 12 }}>
            <a className="btn btn-sm" href={`/api/local/download?file=${encodeURIComponent(result.file)}`} download>
              Download
            </a>
          </div>
        </Notice>
      )}
    </div>
  );
}

export default function ExportPage() {
  return (
    <>
      <PageHead title="Export an agent" sub="Create a portable .agentpack you can keep as a backup, move to another machine or share." />
      <Suspense fallback={<Skeleton rows={4} />}>
        <ExportForm />
      </Suspense>
    </>
  );
}
