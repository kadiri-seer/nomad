"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Badge, Diff, Notice, formatDate } from "./ui";

export function VersionCompare({ agentId, versions, current, onRestored }: { agentId: string; versions: any[]; current: number; onRestored?: () => void }) {
  const [left, setLeft] = useState(versions[1]?.version ?? versions[0]?.version ?? 1);
  const [right, setRight] = useState(versions[0]?.version ?? 1);
  const [cmp, setCmp] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restorePreview, setRestorePreview] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const compare = async (l = left, r = right) => {
    setBusy(true);
    setError(null);
    try {
      setCmp(await api(`agents/${agentId}/compare?left=${l}&right=${r}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: number) => {
    setBusy(true);
    try {
      const r = await api(`agents/${agentId}/restore-version`, { body: { version: v } });
      setDone(`Version ${v} is now current as v${r.version}. Migrate it to a platform to apply it there.`);
      setRestorePreview(null);
      onRestored?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!versions.length) return <p className="muted">No versions yet.</p>;
  return (
    <div className="stack">
      <div className="panel table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">When</th>
              <th scope="col">Why</th>
              <th scope="col">Platform</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>
                  v{v.version} {v.version === current && <Badge kind="info">current</Badge>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{formatDate(v.createdAt)}</td>
                <td>{v.reason}</td>
                <td>{v.platform}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {v.version !== current && (
                    <button
                      className="link-btn"
                      onClick={async () => {
                        setLeft(current);
                        setRight(v.version);
                        await compare(current, v.version);
                        setRestorePreview(v.version);
                      }}
                    >
                      Restore...
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {versions.length > 1 && (
        <div className="row">
          <label className="field" style={{ width: 130 }}>
            <span>Compare</span>
            <select className="select" value={left} onChange={(e) => setLeft(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 130 }}>
            <span>With</span>
            <select className="select" value={right} onChange={(e) => setRight(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-quiet" style={{ alignSelf: "flex-end" }} disabled={busy} onClick={() => { setRestorePreview(null); compare(); }}>
            Compare
          </button>
        </div>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      {cmp && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              {cmp.left} vs {cmp.right}
            </h3>
            {cmp.identical ? <Badge kind="ok">identical</Badge> : <Badge kind="warn">{cmp.changes.length} change(s)</Badge>}
          </div>
          <div className="panel-body stack" style={{ gap: 6 }}>
            {cmp.changes.map((c: any, i: number) => (
              <details key={i} className="diff">
                <summary>
                  <Badge kind={c.change === "added" ? "ok" : c.change === "removed" ? "bad" : "warn"}>{c.change}</Badge> {c.category}: {c.item}
                </summary>
                {c.diff && <Diff text={c.diff} />}
              </details>
            ))}
            {restorePreview !== null && (
              <div className="row" style={{ marginTop: 10 }}>
                <p>Make v{restorePreview} the current version? The current version stays in the history.</p>
                <button className="btn" disabled={busy} onClick={() => restore(restorePreview)}>
                  Restore v{restorePreview}
                </button>
                <button className="btn btn-quiet" onClick={() => setRestorePreview(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
