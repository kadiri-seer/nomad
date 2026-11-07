"use client";

import Link from "next/link";
import { useState } from "react";
import { api, useApi } from "@/lib/client";
import { Badge, Empty, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

export default function Overview() {
  const overview = useApi("overview");
  const scan = useApi<any[]>("scan");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const read = async (adapter: string, root: string, nativeId: string, name: string) => {
    setBusy(`${adapter}${root}${nativeId}`);
    setMsg(null);
    try {
      const r = await api("agents/read", { body: { adapter, root, nativeId } });
      setMsg({ tone: "ok", text: `${name} is in your library (version ${r.version}).${r.secrets ? ` ${r.secrets} secret(s) were redacted.` : ""}` });
      overview.reload();
      scan.reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead title="Overview" sub="Agents on this machine and what Nomad has done with them.">
        <Link href="/app/migrate" className="btn">
          Start a migration
        </Link>
      </PageHead>
      {overview.error && <Notice tone="bad" title="Could not load">{overview.error.message}</Notice>}
      {overview.loading && !overview.data ? (
        <Skeleton rows={1} height={78} />
      ) : overview.data ? (
        <div className="stat-line">
          <div>
            <span className="label">Agents in library</span>
            <b>{overview.data.agents}</b>
          </div>
          <div>
            <span className="label">Known locations</span>
            <b>{overview.data.locations}</b>
          </div>
          <div>
            <span className="label">Backups</span>
            <b>{overview.data.backups}</b>
          </div>
          <div>
            <span className="label">Data folder</span>
            <span className="break" style={{ display: "block", marginTop: 8, fontFamily: "var(--mono)", fontSize: "0.82rem" }}>
              {overview.data.home}
            </span>
          </div>
        </div>
      ) : null}

      <section style={{ marginTop: 32 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: "1.3rem" }}>Found on this machine</h2>
          <button className="btn btn-quiet btn-sm" onClick={() => scan.reload()} disabled={scan.loading}>
            Scan again
          </button>
        </div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {scan.loading && !scan.data ? (
          <Skeleton rows={3} />
        ) : scan.error ? (
          <Notice tone="bad">{scan.error.message}</Notice>
        ) : !scan.data?.length ? (
          <Empty title="No platforms found at their default locations">
            Use <Link href="/app/migrate">Migrate</Link> and enter a folder to work with an agent somewhere else, or <Link href="/app/import">import a package</Link>.
          </Empty>
        ) : (
          <div className="panel table-wrap" style={{ marginTop: msg ? 12 : 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Location</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {scan.data.flatMap((p) =>
                  p.agents.map((a: any) => (
                    <tr key={`${p.adapter}${p.root}${a.nativeId}`}>
                      <td>
                        <strong>{a.name}</strong>
                        <div className="muted" style={{ fontSize: "0.85rem" }}>
                          {a.kind}
                        </div>
                      </td>
                      <td>{p.displayName}</td>
                      <td className="break" style={{ fontFamily: "var(--mono)", fontSize: "0.8rem" }}>
                        {p.root}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {a.agentId ? (
                          <Link className="btn btn-quiet btn-sm" href={`/app/agents/view?id=${a.agentId}`}>
                            Open
                          </Link>
                        ) : (
                          <button className="btn btn-sm" disabled={busy !== null} onClick={() => read(p.adapter, p.root, a.nativeId, a.name)}>
                            {busy === `${p.adapter}${p.root}${a.nativeId}` ? "Reading..." : "Add to library"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: "1.3rem", marginBottom: 12 }}>Recent activity</h2>
        {overview.data && !overview.data.operations.length ? (
          <Empty title="Nothing yet">Migrations, exports, imports and restores will appear here with their receipts.</Empty>
        ) : overview.data ? (
          <div className="panel table-wrap">
            <table className="data">
              <tbody>
                {overview.data.operations.map((o: any) => (
                  <tr key={o.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDate(o.createdAt)}</td>
                    <td>{o.kind}</td>
                    <td>{o.agent}</td>
                    <td>
                      <Badge kind={o.status}>{o.status}</Badge>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/app/history?op=${o.id}`}>Receipt</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
