"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, useApi } from "@/lib/client";
import { VersionCompare } from "@/components/VersionCompare";
import { Badge, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

export default function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading, reload } = useApi(`agents/${id}`);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Skeleton rows={8} />;
  if (error) return <Notice tone="bad" title="Could not load this agent">{error.message}</Notice>;
  if (!data) return null;
  const { agent, doc, versions, locations, operations, backups } = data;

  return (
    <>
      <PageHead title={agent.name} sub={<span style={{ fontFamily: "var(--mono)", fontSize: "0.82rem" }}>{agent.id}</span>}>
        <Link href={`/app/migrate?agent=${agent.id}`} className="btn">
          Migrate
        </Link>
        <Link href={`/app/export?agent=${agent.id}`} className="btn btn-quiet">
          Export
        </Link>
        <button className="btn btn-quiet" disabled={busy || !locations.length} title={locations.length ? undefined : "No known locations to back up"} onClick={() => act(async () => { const r = await api(`agents/${agent.id}/backup`, { body: {} }); return `Backup ${r.id} created with ${r.files} file(s).`; })}>
          Back up files
        </button>
        <button className="btn btn-quiet" disabled={busy} onClick={() => act(async () => { const r = await api(`agents/${agent.id}/duplicate`, { body: {} }); return `Created ${r.name} with a new identity.`; })}>
          Duplicate
        </button>
      </PageHead>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h3>Identity</h3>
            <Badge kind="neutral">v{agent.currentVersion}</Badge>
          </div>
          <dl className="kv panel-body">
            <dt>Original platform</dt>
            <dd>{agent.sourcePlatform}</dd>
            <dt>Description</dt>
            <dd>{doc.description ?? doc.identity.description ?? <span className="muted">None</span>}</dd>
            <dt>Model</dt>
            <dd>{doc.models.preferred ?? <span className="muted">Not set</span>}</dd>
            <dt>Tone</dt>
            <dd>{doc.identity.tone ?? <span className="muted">Not set</span>}</dd>
            <dt>Persona</dt>
            <dd>{doc.identity.persona ? doc.identity.persona.slice(0, 400) : <span className="muted">None</span>}</dd>
            {agent.duplicatedFrom && (
              <>
                <dt>Duplicated from</dt>
                <dd>
                  <Link href={`/app/agents/${agent.duplicatedFrom}`}>{agent.duplicatedFrom}</Link>
                </dd>
              </>
            )}
          </dl>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Current locations</h3>
          </div>
          <div className="panel-body stack" style={{ gap: 10 }}>
            {locations.length ? (
              locations.map((l: any) => (
                <div key={l.id}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{l.adapter}</strong>
                    {l.role === "primary" && <Badge kind="info">primary</Badge>}
                  </div>
                  <div className="break muted" style={{ fontFamily: "var(--mono)", fontSize: "0.8rem" }}>
                    {l.root} #{l.nativeId}
                  </div>
                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                    Seen {formatDate(l.lastSeenAt)}
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">This agent exists only in the library. Migrate it to a platform to use it.</p>
            )}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Portable configuration</h3>
        </div>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr>
                <th scope="row">Instructions</th>
                <td>
                  {doc.instructions.length ? (
                    doc.instructions.map((i: any) => (
                      <details key={i.id} className="diff">
                        <summary>
                          {i.title ?? i.id} <Badge kind="neutral">{i.kind}</Badge>
                        </summary>
                        <pre className="diff-pre" style={{ whiteSpace: "pre-wrap" }}>{i.content}</pre>
                      </details>
                    ))
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Memory</th>
                <td>
                  {doc.memory.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {doc.memory.map((m: any) => (
                        <li key={m.id} style={{ marginBottom: 4 }}>
                          <Badge kind="neutral">{m.kind}</Badge> {m.content.replace(/^[-*]\s+/, "").slice(0, 200)}
                          {m.source?.platform && <span className="muted"> ({m.source.platform}{m.source.path ? `: ${m.source.path}` : ""})</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Skills</th>
                <td>{doc.skills.length ? doc.skills.map((s: any) => <div key={s.name}><strong>{s.name}</strong> <span className="muted">{s.description}</span></div>) : <span className="muted">None</span>}</td>
              </tr>
              <tr>
                <th scope="row">Tools</th>
                <td>
                  {doc.tools.length ? (
                    doc.tools.map((t: any) => (
                      <div key={t.name}>
                        <strong>{t.name}</strong> <span className="muted">{t.mcp ? `${t.mcp.transport} ${t.mcp.command ?? t.mcp.url ?? ""}` : t.kind}</span>
                        {t.mcp && Object.entries(t.mcp.env).filter(([, v]: any) => v.secretRef).length > 0 && <span className="muted"> (credentials to reconnect: {Object.entries(t.mcp.env).filter(([, v]: any) => v.secretRef).map(([k]) => k).join(", ")})</span>}
                      </div>
                    ))
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Routines</th>
                <td>{doc.workflows.length ? doc.workflows.map((w: any) => <div key={w.id}>{w.name} <span className="muted">{w.trigger.kind === "cron" ? w.trigger.expr : w.trigger.kind}{w.timezone ? ` ${w.timezone}` : ""}</span> {w.sourceEnabled ? <Badge kind="ok">active at source</Badge> : <Badge kind="neutral">paused</Badge>}</div>) : <span className="muted">None</span>}</td>
              </tr>
              <tr>
                <th scope="row">Permissions</th>
                <td>
                  Mode {doc.permissions.mode}.{" "}
                  <span className="tag-list" style={{ display: "inline-flex" }}>
                    {doc.permissions.rules.map((r: any, i: number) => (
                      <Badge key={i} kind={r.effect === "deny" ? "bad" : r.effect === "ask" ? "warn" : "ok"}>
                        {r.effect} {r.capability}
                        {r.pattern ? ` ${r.pattern}` : ""}
                      </Badge>
                    ))}
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="row">Integrations</th>
                <td>{doc.integrations.map((i: any) => i.name).join(", ") || <span className="muted">None</span>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <section style={{ marginTop: 24 }} id="versions">
        <h2 style={{ fontSize: "1.3rem", marginBottom: 12 }}>Version history</h2>
        <VersionCompare agentId={agent.id} versions={versions} current={agent.currentVersion} onRestored={reload} />
      </section>

      <div className="grid-2" style={{ marginTop: 24 }}>
        <section>
          <h2 style={{ fontSize: "1.3rem", marginBottom: 12 }}>Migration history</h2>
          <div className="panel panel-body stack" style={{ gap: 8 }}>
            {operations.length ? (
              operations.slice(0, 10).map((o: any) => (
                <div key={o.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    {o.kind} <span className="muted">{formatDate(o.createdAt)}</span>
                  </span>
                  <Link href={`/app/history?op=${o.id}`}>
                    <Badge kind={o.status}>{o.status}</Badge>
                  </Link>
                </div>
              ))
            ) : (
              <p className="muted">No operations yet.</p>
            )}
          </div>
        </section>
        <section>
          <h2 style={{ fontSize: "1.3rem", marginBottom: 12 }}>Backups</h2>
          <div className="panel panel-body stack" style={{ gap: 8 }}>
            {backups.length ? (
              backups.slice(0, 10).map((b: any) => (
                <div key={b.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    {b.kind} <span className="muted">{formatDate(b.createdAt)}, {b.fileCount} files</span>
                  </span>
                  <Link href={`/app/backups?id=${b.id}`}>Review</Link>
                </div>
              ))
            ) : (
              <p className="muted">No backups yet.</p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
