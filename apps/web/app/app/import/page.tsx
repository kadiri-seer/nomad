"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { PackageUpload } from "@/components/PackageUpload";
import { Notice, PageHead } from "@/components/ui";

export default function ImportPage() {
  const [upload, setUpload] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("import", { body: { path: upload.path } });
      if (!r.ok) setError(r.issues.map((i: any) => `${i.path}: ${i.message}`).join("; "));
      else setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Import a package" sub="Add an agent from a .nomad file to your library. Writing it to a platform is a separate, previewed step." />
      <div className="stack" style={{ maxWidth: 760 }}>
        <PackageUpload
          onDone={(r) => {
            setUpload(r);
            setResult(null);
          }}
        />
        {upload?.ok && !result && (
          <div className="panel">
            <div className="panel-head">
              <h3>{upload.name}</h3>
              <code style={{ fontSize: "0.75rem" }}>{upload.id}</code>
            </div>
            <div className="panel-body stack" style={{ gap: 10 }}>
              <p>
                {upload.counts.instructions} instruction section(s), {upload.counts.memory} memory entries, {upload.counts.skills} skill(s), {upload.counts.tools} tool(s), {upload.counts.workflows} routine(s), {upload.files} files.
              </p>
              {upload.secrets > 0 && <Notice tone="warn">{upload.secrets} secret pattern(s) were found in the package. They are redacted on import.</Notice>}
              {upload.warnings.map((w: string) => (
                <p key={w} className="muted">
                  {w}
                </p>
              ))}
              <div className="row">
                <button className="btn" disabled={busy} onClick={doImport}>
                  {busy ? "Importing..." : "Import into library"}
                </button>
              </div>
            </div>
          </div>
        )}
        {error && <Notice tone="bad" title="Import failed">{error}</Notice>}
        {result && (
          <Notice tone="ok" title={result.recognized ? `${result.name} was already in your library` : `${result.name} was imported`}>
            {result.recognized ? `Its identity matched, so this became version ${result.version} instead of a duplicate.` : `Saved as version ${result.version}.`} Routines in the package are paused.
            <div className="row" style={{ marginTop: 12 }}>
              <Link href={`/app/agents/view?id=${result.agentId}`} className="btn btn-sm">
                Open agent
              </Link>
              <Link href={`/app/migrate?agent=${result.agentId}`} className="btn btn-quiet btn-sm">
                Migrate it to a platform
              </Link>
            </div>
          </Notice>
        )}
      </div>
    </>
  );
}
