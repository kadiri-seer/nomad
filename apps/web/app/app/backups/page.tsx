"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, useApi } from "@/lib/client";
import { Badge, Diff, Empty, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

function Backups() {
  const params = useSearchParams();
  const list = useApi<any[]>("backups");
  const [selected, setSelected] = useState<string | null>(params.get("id"));
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setPreview(null);
    setConfirm(false);
    api(`backups/${selected}`)
      .then(setPreview)
      .catch((e) => setMsg({ tone: "bad", text: e.message }))
      .finally(() => setLoading(false));
  }, [selected]);

  const restore = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const r = await api(`backups/${selected}/restore`, { body: {} });
      setMsg({ tone: "ok", text: `Restored ${r.preview.changes} file(s). The state before this restore was saved as backup ${r.safetyBackup}.` });
      setPreview(null);
      setSelected(null);
      list.reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.loading && !list.data ? (
        <Skeleton rows={4} />
      ) : !list.data?.length ? (
        <Empty title="No backups yet">Nomad backs up every file before a migration writes it. You can also snapshot an agent from its page.</Empty>
      ) : (
        <div className="panel table-wrap" style={{ marginTop: msg ? 16 : 0 }}>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Kind</th>
                <th scope="col">Description</th>
                <th scope="col">Files</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(b.createdAt)}</td>
                  <td>
                    <Badge kind="neutral">{b.kind}</Badge> {b.restoredAt && <Badge kind="info">restored</Badge>}
                  </td>
                  <td>{b.description}</td>
                  <td>{b.fileCount}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="link-btn" onClick={() => setSelected(b.id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h3>Restore {selected}</h3>
            <button className="btn btn-quiet btn-sm" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <div className="panel-body stack">
            {loading && !preview ? (
              <Skeleton rows={3} />
            ) : preview ? (
              <>
                <p>{preview.changes ? `${preview.changes} file(s) would change.` : "Every file already matches this backup."}</p>
                {preview.items.map((i: any) => (
                  <div key={i.abs}>
                    <Badge kind={i.action === "restore" ? "warn" : i.action === "delete" ? "bad" : i.action === "skip" ? "info" : "neutral"}>{i.action}</Badge> <code className="break">{i.path}</code> {i.reason && <span className="muted">{i.reason}</span>}
                    {i.diff && (
                      <details className="diff">
                        <summary>Show what changes</summary>
                        <Diff text={i.diff} />
                      </details>
                    )}
                  </div>
                ))}
                {preview.changes > 0 && (
                  <>
                    <label className="check">
                      <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                      <span>Restore these files. The current state is backed up first.</span>
                    </label>
                    <div>
                      <button className="btn" disabled={!confirm || loading} onClick={restore}>
                        Restore backup
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

export default function BackupsPage() {
  return (
    <>
      <PageHead title="Backups" sub="Everything Nomad changed can be put back. Restoring shows a preview first and is itself backed up." />
      <Suspense fallback={<Skeleton rows={4} />}>
        <Backups />
      </Suspense>
    </>
  );
}
