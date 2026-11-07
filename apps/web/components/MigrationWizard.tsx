"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { COMPONENT_CATEGORIES, type ComponentCategory } from "@nomad/schema";
import { CATEGORY_LABELS } from "@nomad/compatibility";
import { api, useApi } from "@/lib/client";
import { CompatTable } from "./CompatTable";
import { PackageUpload } from "./PackageUpload";
import { Badge, Diff, Empty, Notice, Skeleton } from "./ui";

const STEPS = ["Source", "Locate", "Agent", "Destination", "Compatibility", "Changes", "Conflicts", "Approve", "Execute", "Results"];

type SourceKind = "platform" | "package" | "library";
type Mode = "merge" | "copy" | "replace";

const MODES: Array<{ id: Mode; title: string; text: string }> = [
  { id: "merge", title: "Merge", text: "Keep everything already at the destination and add what is missing. Differences are reported, not overwritten." },
  { id: "copy", title: "Copy", text: "Create a separate agent next to the existing ones. Nothing existing is modified." },
  { id: "replace", title: "Replace", text: "Overwrite the agent's configuration at the destination. Content Nomad did not write needs your explicit approval." }
];

const ACTION_LABEL: Record<string, { label: string; kind: string }> = {
  create: { label: "new", kind: "ok" },
  update: { label: "modified", kind: "warn" },
  "keep-existing": { label: "kept", kind: "info" },
  unchanged: { label: "same", kind: "neutral" }
};

export function MigrationWizard() {
  const params = useSearchParams();
  const adapters = useApi<any[]>("adapters");
  const scan = useApi<any[]>("scan");
  const library = useApi<any[]>("agents");

  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [kind, setKind] = useState<SourceKind>("platform");
  const [srcAdapter, setSrcAdapter] = useState("openclaw");
  const [srcRoot, setSrcRoot] = useState("");
  const [discovered, setDiscovered] = useState<any[] | null>(null);
  const [nativeId, setNativeId] = useState("");
  const [upload, setUpload] = useState<any>(null);
  const [agentId, setAgentId] = useState("");
  const [version, setVersion] = useState<number | "">("");
  const [destAdapter, setDestAdapter] = useState("claude-code");
  const [destRoot, setDestRoot] = useState("");
  const [mode, setMode] = useState<Mode>("merge");
  const [targetName, setTargetName] = useState("");
  const [components, setComponents] = useState<Set<ComponentCategory>>(new Set(COMPONENT_CATEGORIES));
  const [plan, setPlan] = useState<any>(null);
  const [approvals, setApprovals] = useState({ replace: false, overwriteModified: false, broaderPermissions: false });
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  useEffect(() => {
    const a = params.get("agent");
    if (a) {
      setKind("library");
      setAgentId(a);
      setStep(3);
      setFurthest(3);
    }
  }, [params]);

  const info = (id: string) => adapters.data?.find((a) => a.id === id);
  const readable = useMemo(() => (adapters.data ?? []).filter((a) => a.support !== "GUIDED"), [adapters.data]);

  useEffect(() => {
    const i = info(srcAdapter);
    if (i && !srcRoot) setSrcRoot(i.defaultLocations[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcAdapter, adapters.data]);

  useEffect(() => {
    const i = info(destAdapter);
    if (!i) return;
    setDestRoot(i.defaultLocations[0] ?? (i.support === "GUIDED" ? `~/nomad-kits/${i.id}` : ""));
    if (!i.multiAgent && mode === "copy" && i.support !== "GUIDED") setMode("merge");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destAdapter, adapters.data]);

  const invalidate = () => {
    setPlan(null);
    setReceipt(null);
    setConfirmed(false);
    setApprovals({ replace: false, overwriteModified: false, broaderPermissions: false });
    setFurthest((f) => Math.min(f, 3));
  };

  const go = (n: number) => {
    setError(null);
    setStep(n);
    setFurthest((f) => Math.max(f, n));
    window.scrollTo({ top: 0 });
  };

  const source = () => {
    if (kind === "platform") return { kind: "location", adapter: srcAdapter, root: srcRoot, nativeId };
    if (kind === "package") return { kind: "package", path: upload?.path };
    return { kind: "stored", agentId, version: version || undefined };
  };

  const discover = async () => {
    setBusy(true);
    setError(null);
    setDiscovered(null);
    try {
      const r = await api(`discover?adapter=${encodeURIComponent(srcAdapter)}&root=${encodeURIComponent(srcRoot)}`);
      setDiscovered(r.agents);
      if (r.agents.length) setNativeId(r.agents[0].nativeId);
      if (!r.detection.detected) setError({ message: `${info(srcAdapter)?.displayName} was not detected in that folder.`, hint: "Check the path, or pick another platform." });
      else go(2);
    } catch (e: any) {
      setError({ message: e.message, hint: e.hint });
    } finally {
      setBusy(false);
    }
  };

  const makePlan = async (overrideMode?: Mode) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api("plan", {
        body: { source: source(), destination: { adapter: destAdapter, root: destRoot }, mode: overrideMode ?? mode, targetName: targetName || undefined, components: [...components] }
      });
      if (overrideMode) setMode(overrideMode);
      setPlan(p);
      setApprovals({ replace: false, overwriteModified: false, broaderPermissions: false });
      setConfirmed(false);
      go(overrideMode ? 6 : 4);
    } catch (e: any) {
      setError({ message: e.message, hint: e.hint });
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    go(8);
    setBusy(true);
    try {
      const r = await api("execute", { body: { planId: plan.id, token: plan.token, approvals } });
      setReceipt(r);
      go(9);
    } catch (e: any) {
      setError({ message: e.message, hint: e.hint });
      setStep(7);
    } finally {
      setBusy(false);
    }
  };

  const missingApprovals = plan
    ? plan.approvalsRequired.filter((a: string) => (a === "replace" && !approvals.replace) || (a === "overwrite-modified" && !approvals.overwriteModified) || (a === "broader-permissions" && !approvals.broaderPermissions))
    : [];

  const canNext: Record<number, boolean> = {
    0: true,
    1: kind === "platform" ? !!srcRoot && !!srcAdapter : kind === "package" ? !!upload?.ok : !!agentId,
    2: kind === "platform" ? !!nativeId : true,
    3: !!destAdapter && !!destRoot && components.size > 0 && (mode !== "copy" || true),
    4: !!plan,
    5: !!plan,
    6: !!plan && missingApprovals.length === 0,
    7: !!plan && confirmed && !plan.blocked.length && missingApprovals.length === 0
  };

  const destInfo = info(destAdapter);
  const locked = step >= 8;

  return (
    <div>
      <ol className="stepper" aria-label="Migration steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? "current" : i < step || i <= furthest ? "done" : ""}>
            <button disabled={locked || i > furthest || (i >= 4 && !plan)} onClick={() => go(i)} aria-current={i === step ? "step" : undefined}>
              {String(i + 1).padStart(2, "0")} {s}
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="bad" title={error.message}>
            {error.hint}
          </Notice>
        </div>
      )}

      {/* 1. Source */}
      {step === 0 && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Where does the agent live now?</h2>
          <div className="choice-list">
            {[
              { id: "platform", title: "On a platform on this machine", text: "OpenClaw, Claude Code, Codex, Hermes, Cursor and other supported tools." },
              { id: "package", title: "In a .nomad file", text: "A package exported by Nomad, from this machine or another one." },
              { id: "library", title: "In my Nomad library", text: "An agent Nomad has already read, including earlier versions." }
            ].map((c) => (
              <label key={c.id} className="choice">
                <input type="radio" name="source" checked={kind === c.id} onChange={() => { setKind(c.id as SourceKind); invalidate(); }} />
                <span>
                  <strong>{c.title}</strong>
                  <small>{c.text}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* 2. Locate */}
      {step === 1 && kind === "platform" && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Find the platform</h2>
          {scan.loading && !scan.data ? (
            <Skeleton rows={2} />
          ) : scan.data?.length ? (
            <div className="choice-list">
              {scan.data.map((p) => (
                <button
                  key={`${p.adapter}${p.root}`}
                  className="choice"
                  aria-pressed={srcAdapter === p.adapter && srcRoot === p.root}
                  onClick={() => {
                    setSrcAdapter(p.adapter);
                    setSrcRoot(p.root);
                    invalidate();
                  }}
                >
                  <span>
                    <strong>{p.displayName}</strong>
                    <small>
                      {p.root}, {p.agents.length} agent(s)
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">No platforms were found at their default locations. Enter one below.</p>
          )}
          <div className="grid-form">
            <label className="field">
              <span>Platform</span>
              <select className="select" value={srcAdapter} onChange={(e) => { setSrcAdapter(e.target.value); setSrcRoot(""); invalidate(); }}>
                {readable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Folder</span>
              <input className="input" value={srcRoot} placeholder={info(srcAdapter)?.defaultLocations[0] ?? "/path/to/project"} onChange={(e) => { setSrcRoot(e.target.value); invalidate(); }} />
            </label>
          </div>
        </section>
      )}
      {step === 1 && kind === "package" && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Upload the package</h2>
          <PackageUpload onDone={(r) => { setUpload(r); invalidate(); }} />
          {upload?.ok && (
            <Notice tone="ok" title={`${upload.name} is valid`}>
              {upload.counts.instructions} instruction section(s), {upload.counts.memory} memory entries, {upload.counts.skills} skill(s), {upload.counts.tools} tool(s), {upload.counts.workflows} routine(s).
            </Notice>
          )}
        </section>
      )}
      {step === 1 && kind === "library" && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Choose an agent from your library</h2>
          {library.loading && !library.data ? (
            <Skeleton rows={3} />
          ) : !library.data?.length ? (
            <Empty title="Your library is empty">Add an agent from the Overview page or import a package first.</Empty>
          ) : (
            <div className="choice-list">
              {library.data.map((a) => (
                <label key={a.id} className="choice">
                  <input type="radio" name="lib" checked={agentId === a.id} onChange={() => { setAgentId(a.id); setVersion(""); invalidate(); }} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>
                      v{a.currentVersion} from {a.sourcePlatform}, {a.skills} skill(s), {a.memoryEntries} memory entries
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 3. Agent */}
      {step === 2 && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Which agent?</h2>
          {kind === "platform" &&
            (discovered?.length ? (
              <div className="choice-list">
                {discovered.map((a) => (
                  <label key={a.nativeId} className="choice">
                    <input type="radio" name="agent" checked={nativeId === a.nativeId} onChange={() => { setNativeId(a.nativeId); invalidate(); }} />
                    <span>
                      <strong>{a.name}</strong>
                      <small>
                        {a.kind}
                        {a.description ? `, ${a.description}` : ""}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <Empty title="No agents found in that folder" />
            ))}
          {kind === "package" && upload && <Notice title={upload.name}>Agent id {upload.id}. The package holds one agent.</Notice>}
          {kind === "library" && (
            <div className="grid-form">
              <Notice title={library.data?.find((a) => a.id === agentId)?.name ?? agentId}>The latest version is used unless you pick another one.</Notice>
              <label className="field">
                <span>Version</span>
                <input className="input" type="number" min={1} placeholder="Latest" value={version} onChange={(e) => { setVersion(e.target.value ? Number(e.target.value) : ""); invalidate(); }} />
              </label>
            </div>
          )}
        </section>
      )}

      {/* 4. Destination */}
      {step === 3 && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Where should it go?</h2>
          <div className="grid-form">
            <label className="field">
              <span>Platform</span>
              <select className="select" value={destAdapter} onChange={(e) => { setDestAdapter(e.target.value); invalidate(); }}>
                <optgroup label="Direct">
                  {(adapters.data ?? []).filter((a) => a.support !== "GUIDED").map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName} ({a.support.toLowerCase()})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Guided (writes a setup kit)">
                  {(adapters.data ?? []).filter((a) => a.support === "GUIDED").map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="field">
              <span>{destInfo?.support === "GUIDED" ? "Folder for the kit" : "Folder"}</span>
              <input className="input" value={destRoot} placeholder="/path/to/project" onChange={(e) => { setDestRoot(e.target.value); invalidate(); }} />
            </label>
          </div>
          {destInfo && (
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              <Badge kind={destInfo.support}>{destInfo.support.toLowerCase()}</Badge> {destInfo.description}
            </p>
          )}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 8 }}>
              If something already exists there
            </legend>
            <div className="choice-list">
              {MODES.map((m) => {
                const disabled = m.id === "copy" && destInfo && !destInfo.multiAgent && destInfo.support !== "GUIDED";
                return (
                  <label key={m.id} className="choice" style={disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                    <input type="radio" name="mode" disabled={!!disabled} checked={mode === m.id} onChange={() => { setMode(m.id); invalidate(); }} />
                    <span>
                      <strong>{m.title}</strong>
                      <small>{disabled ? `${destInfo.displayName} holds one agent per folder, so copy is not available.` : m.text}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {mode === "copy" && (
            <label className="field" style={{ maxWidth: 360 }}>
              <span>Name of the new agent</span>
              <input className="input" value={targetName} placeholder="Defaults to the agent's name" onChange={(e) => { setTargetName(e.target.value); invalidate(); }} />
            </label>
          )}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 4 }}>
              What to transfer
            </legend>
            <div className="grid-form" style={{ gap: 0 }}>
              {COMPONENT_CATEGORIES.filter((c) => c !== "identity").map((c) => (
                <label key={c} className="check">
                  <input
                    type="checkbox"
                    checked={components.has(c)}
                    onChange={(e) => {
                      const next = new Set(components);
                      if (e.target.checked) next.add(c);
                      else next.delete(c);
                      next.add("identity");
                      setComponents(next);
                      invalidate();
                    }}
                  />
                  <span>{CATEGORY_LABELS[c]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      )}

      {/* 5. Compatibility */}
      {step === 4 && plan && (
        <section className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ fontSize: "1.4rem" }}>
              {plan.agent.name} to {plan.destination.displayName}
            </h2>
            <span className="score">
              <b>{plan.compatibility.score ?? "n/a"}</b>
              <span className="muted">/100</span>
            </span>
          </div>
          <p className="muted" style={{ fontSize: "0.88rem" }}>
            {plan.compatibility.scoreExplanation}
          </p>
          {plan.compatibility.attention.length > 0 && (
            <Notice tone="warn" title="Needs attention">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.compatibility.attention.map((a: string) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="panel">
            <CompatTable report={plan.compatibility} />
          </div>
        </section>
      )}

      {/* 6. Changes */}
      {step === 5 && plan && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>What will change</h2>
          <div className="stat-line">
            <div>
              <span className="label">New files</span>
              <b>{plan.summary.create}</b>
            </div>
            <div>
              <span className="label">Modified</span>
              <b>{plan.summary.update}</b>
            </div>
            <div>
              <span className="label">Kept as is</span>
              <b>{plan.summary.kept}</b>
            </div>
            <div>
              <span className="label">Unchanged</span>
              <b>{plan.summary.unchanged}</b>
            </div>
          </div>
          <div className="panel">
            {plan.operations.map((o: any) => (
              <div key={o.path} style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
                <div className="row" style={{ gap: 10 }}>
                  <Badge kind={ACTION_LABEL[o.action]?.kind ?? "neutral"}>{ACTION_LABEL[o.action]?.label ?? o.action}</Badge>
                  <code className="break" style={{ fontSize: "0.82rem" }}>
                    {o.path}
                  </code>
                </div>
                <p className="muted" style={{ fontSize: "0.88rem", marginTop: 4 }}>
                  {o.description}
                </p>
                {o.error && <p style={{ color: "var(--bad)" }}>{o.error}</p>}
                {o.diff && (
                  <details className="diff">
                    <summary>Show diff</summary>
                    <Diff text={o.diff} />
                  </details>
                )}
              </div>
            ))}
          </div>
          {plan.conversions.length > 0 && (
            <div className="panel panel-body">
              <h3 style={{ marginBottom: 8 }}>Converted</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.conversions.map((c: any, i: number) => (
                  <li key={i}>
                    {CATEGORY_LABELS[c.category as ComponentCategory]}: {c.item}, {c.from} to {c.to}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.unsupported.length > 0 && (
            <div className="panel panel-body">
              <h3 style={{ marginBottom: 8 }}>Cannot be transferred</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.unsupported.map((u: any, i: number) => (
                  <li key={i}>
                    <strong>{u.item}</strong> ({CATEGORY_LABELS[u.category as ComponentCategory]}): {u.reason} {u.alternative && <span className="muted">{u.alternative}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(plan.secrets.findings > 0 || plan.secrets.strippedEnv.length > 0) && (
            <Notice tone="warn" title="Secrets">
              {plan.secrets.findings} secret(s) detected in the agent and redacted. {plan.secrets.strippedEnv.length ? `Credentials to reconnect: ${plan.secrets.strippedEnv.join(", ")}.` : ""}
            </Notice>
          )}
          {plan.disabledRoutines.length > 0 && <Notice title="Routines are imported paused">{plan.disabledRoutines.join(", ")}. Enable them at the destination after reviewing them.</Notice>}
          {plan.manualSteps.length > 0 && (
            <div className="panel panel-body">
              <h3 style={{ marginBottom: 8 }}>Steps after migration</h3>
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {plan.manualSteps.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {/* 7. Conflicts */}
      {step === 6 && plan && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Conflicts and permissions</h2>
          {plan.conflicts.length === 0 && plan.permissions.widened.length === 0 && plan.permissions.unenforced.length === 0 && plan.approvalsRequired.length === 0 ? (
            <Notice tone="ok" title="No conflicts">Nothing at the destination conflicts with this agent, and its permissions stay the same or stricter.</Notice>
          ) : null}
          {plan.conflicts.length > 0 && (
            <div className="panel panel-body">
              <h3 style={{ marginBottom: 8 }}>Existing content</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.conflicts.map((c: any, i: number) => (
                  <li key={i}>
                    <code className="break">{c.path}</code>: {c.detail}
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: 14 }}>
                <span className="muted">Current mode: {plan.mode}.</span>
                {plan.mode !== "merge" && (
                  <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => makePlan("merge")}>
                    Preview with merge
                  </button>
                )}
                {plan.mode !== "replace" && (
                  <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => makePlan("replace")}>
                    Preview with replace
                  </button>
                )}
                {plan.mode !== "copy" && (destInfo?.multiAgent || destInfo?.support === "GUIDED") && (
                  <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => makePlan("copy")}>
                    Preview as a copy
                  </button>
                )}
              </div>
            </div>
          )}
          {plan.permissions.widened.length > 0 && (
            <Notice tone="bad" title="The destination would allow more than it does now">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.permissions.widened.map((w: string) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          {plan.permissions.unenforced.length > 0 && (
            <Notice tone="warn" title="Restrictions the destination will not enforce">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.permissions.unenforced.map((w: string) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          {plan.approvalsRequired.length > 0 && (
            <div className="panel panel-body">
              <h3 style={{ marginBottom: 6 }}>Approvals needed</h3>
              {plan.approvalsRequired.includes("replace") && (
                <label className="check">
                  <input type="checkbox" checked={approvals.replace} onChange={(e) => setApprovals({ ...approvals, replace: e.target.checked })} />
                  <span>Replace content at the destination that Nomad did not write.</span>
                </label>
              )}
              {plan.approvalsRequired.includes("overwrite-modified") && (
                <label className="check">
                  <input type="checkbox" checked={approvals.overwriteModified} onChange={(e) => setApprovals({ ...approvals, overwriteModified: e.target.checked })} />
                  <span>Overwrite files that were edited after Nomad wrote them.</span>
                </label>
              )}
              {plan.approvalsRequired.includes("broader-permissions") && (
                <label className="check">
                  <input type="checkbox" checked={approvals.broaderPermissions} onChange={(e) => setApprovals({ ...approvals, broaderPermissions: e.target.checked })} />
                  <span>Apply the broader permissions listed above.</span>
                </label>
              )}
            </div>
          )}
        </section>
      )}

      {/* 8. Approve */}
      {step === 7 && plan && (
        <section className="stack">
          <h2 style={{ fontSize: "1.4rem" }}>Approve the migration</h2>
          <div className="panel">
            <dl className="kv panel-body">
              <dt>Agent</dt>
              <dd>{plan.agent.name}</dd>
              <dt>From</dt>
              <dd>{plan.source.label}</dd>
              <dt>To</dt>
              <dd className="break">
                {plan.destination.displayName}, {plan.destination.root}
              </dd>
              <dt>Mode</dt>
              <dd>{plan.mode}</dd>
              <dt>Files</dt>
              <dd>
                {plan.summary.create} new, {plan.summary.update} modified, {plan.summary.kept} kept
              </dd>
              <dt>Not transferred</dt>
              <dd>{plan.unsupported.length ? plan.unsupported.map((u: any) => u.item).join(", ") : "Nothing"}</dd>
              <dt>Backup</dt>
              <dd>Every affected file is backed up first. You can restore it from the results page or Backups.</dd>
            </dl>
          </div>
          {plan.blocked.length > 0 && (
            <Notice tone="bad" title="This migration cannot run">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {plan.blocked.map((b: string) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Notice>
          )}
          {missingApprovals.length > 0 && <Notice tone="warn" title="Approvals missing">Go back to Conflicts to approve: {missingApprovals.join(", ")}.</Notice>}
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I reviewed the preview and want Nomad to apply these changes.</span>
          </label>
        </section>
      )}

      {/* 9. Execute */}
      {step === 8 && (
        <section className="stack" aria-live="polite">
          <h2 style={{ fontSize: "1.4rem" }}>Migrating</h2>
          <p className="muted">Backing up, writing files atomically and verifying the result.</p>
          <Skeleton rows={4} />
        </section>
      )}

      {/* 10. Results */}
      {step === 9 && receipt && <ReceiptView receipt={receipt} />}

      {step < 8 && (
        <div className="wizard-foot">
          <button className="btn btn-quiet" disabled={step === 0 || busy} onClick={() => go(step - 1)}>
            Back
          </button>
          {step === 1 && kind === "platform" ? (
            <button className="btn" disabled={!canNext[1] || busy} onClick={discover}>
              {busy ? "Looking..." : "Find agents"}
            </button>
          ) : step === 3 ? (
            <button className="btn" disabled={!canNext[3] || busy} onClick={() => makePlan()}>
              {busy ? "Preparing preview..." : "Preview migration"}
            </button>
          ) : step === 7 ? (
            <button className="btn btn-lime" disabled={!canNext[7] || busy} onClick={execute}>
              Apply migration
            </button>
          ) : (
            <button className="btn" disabled={!canNext[step] || busy} onClick={() => go(step + 1)}>
              Continue
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ReceiptView({ receipt }: { receipt: any }) {
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ok = receipt.status === "success";
  const restore = async () => {
    setRestoring(true);
    setErr(null);
    try {
      const r = await api(`backups/${receipt.backupId}/restore`, { body: {} });
      setRestored(`Restored ${r.preview.changes} file(s). The state before the restore is kept in backup ${r.safetyBackup}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };
  return (
    <section className="stack">
      <Notice tone={ok ? "ok" : "bad"} title={ok ? "Migration complete and verified" : receipt.status === "verification-failed" ? "Files were written, but verification found problems" : "The migration failed and every change was rolled back"}>
        {receipt.error ?? `${receipt.agent.name} is now in ${receipt.destination.adapter} at ${receipt.destination.root}.`}
      </Notice>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h3>Verification</h3>
          </div>
          <ul className="panel-body" style={{ listStyle: "none", margin: 0 }}>
            {receipt.verification.map((v: any, i: number) => (
              <li key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <Badge kind={v.ok ? "ok" : "bad"}>{v.ok ? "pass" : "fail"}</Badge> {v.name} {v.detail && <span className="muted">{v.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Receipt</h3>
            <code style={{ fontSize: "0.75rem" }}>{receipt.operationId}</code>
          </div>
          <dl className="kv panel-body">
            <dt>Transferred</dt>
            <dd>{receipt.transferred.map((t: any) => `${t.category} (${t.items})`).join(", ") || "Nothing"}</dd>
            <dt>Converted</dt>
            <dd>{receipt.converted.length}</dd>
            <dt>Excluded</dt>
            <dd>{receipt.excluded.map((x: any) => x.item).join(", ") || "Nothing"}</dd>
            <dt>Files written</dt>
            <dd>{receipt.files.filter((f: any) => f.action === "create" || f.action === "update").length}</dd>
            <dt>Paused routines</dt>
            <dd>{receipt.disabledRoutines.join(", ") || "None"}</dd>
          </dl>
        </div>
      </div>
      {receipt.manualSteps.length > 0 && (
        <div className="panel panel-body">
          <h3 style={{ marginBottom: 8 }}>Finish the setup</h3>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {receipt.manualSteps.map((s: string, i: number) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      {receipt.warnings.length > 0 && (
        <details className="diff">
          <summary>{receipt.warnings.length} warning(s)</summary>
          <ul>
            {receipt.warnings.map((w: string, i: number) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {restored && <Notice tone="ok">{restored}</Notice>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="row">
        <Link href={`/app/agents/${receipt.agent.id}`} className="btn">
          Open the agent
        </Link>
        {receipt.backupId && !restored && receipt.status !== "failed-rolled-back" && (
          <button className="btn btn-quiet" disabled={restoring} onClick={restore}>
            {restoring ? "Restoring..." : "Undo: restore the previous state"}
          </button>
        )}
        <a href="/app/migrate" className="btn btn-quiet">
          Start another
        </a>
      </div>
    </section>
  );
}
