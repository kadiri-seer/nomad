"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { Notice, Skeleton } from "./ui";

/** Upload an .agentpack to the local Nomad service, which validates it before keeping it. */
export function PackageUpload({ onDone }: { onDone: (r: any) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setIssues(null);
    setError(null);
    try {
      const r = await api("packages", { raw: await f.arrayBuffer() });
      if (!r.ok) setIssues(r.issues);
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div
        className="dropzone"
        data-active={drag}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          send(e.dataTransfer.files[0]);
        }}
      >
        <p style={{ fontWeight: 600 }}>Drop an .agentpack or .jetpack here</p>
        <p className="muted" style={{ marginTop: 4 }}>
          It is validated before anything is read: structure, integrity hashes and safety checks.
        </p>
        <button className="btn" style={{ marginTop: 14 }} onClick={() => input.current?.click()} disabled={busy}>
          {busy ? "Checking..." : "Choose a file"}
        </button>
        <input ref={input} type="file" accept=".agentpack,.jetpack,.zip" className="visually-hidden" aria-label="Choose an agent package" onChange={(e) => send(e.target.files?.[0])} />
      </div>
      {busy && <Skeleton rows={2} />}
      {error && <Notice tone="bad">{error}</Notice>}
      {issues && (
        <Notice tone="bad" title="The package was rejected">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {issues.map((i, n) => (
              <li key={n}>
                <code>{i.path}</code> {i.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}
