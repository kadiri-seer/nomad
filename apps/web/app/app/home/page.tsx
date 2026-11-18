"use client";

import Link from "next/link";
import { useState } from "react";
import { api, useApi } from "@/lib/client";
import { Badge, Empty, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

type Copy = { adapter: string; app: string; root: string; display: string; nativeId: string; behind: boolean };
type HomeAgent = { id: string; name: string; description: string | null; version: number; updatedAt: string; copies: Copy[]; tools: string[]; skills: string[]; memoryEntries: number; fromOthers: boolean };
type Change = { key: string; category: string; label: string; action: "add" | "update" | "conflict" | "skip"; reason?: string; home?: string; incoming: string; resolution?: "home" | "incoming" };

function saveLabel(add: number, update: number, name: string): string {
  const what = [add ? `${add} new` : "", update ? `${update} changed` : ""].filter(Boolean).join(" and ");
  return `Save ${what} entr${add + update === 1 ? "y" : "ies"} to ${name} in my home.`;
}

export default function YourNomad() {
  const home = useApi<{ agents: HomeAgent[]; notInHomeYet: Array<{ name: string; app: string; display: string }> }>("home");
  const apps = useApi<Array<{ app: string; displayName: string; detected: boolean; connected: boolean; writes: boolean; config: string }>>("connect");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [borrowed, setBorrowed] = useState<{ name: string; version: number; text: string; truncated: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [back, setBack] = useState<{ agent: HomeAgent; copy: Copy; preview: any } | null>(null);
  const [prefer, setPrefer] = useState<Record<string, "home" | "incoming">>({});
  const [confirm, setConfirm] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const gather = () =>
    act(async () => {
      const r = await api("home/gather", { body: {} });
      const added = r.gathered.filter((g: any) => g.added).length;
      setMsg({ tone: r.failed.length ? "bad" : "ok", text: `${added} agent(s) added, ${r.gathered.length - added} updated.${r.failed.length ? ` ${r.failed.length} could not be read: ${r.failed.map((f: any) => `${f.app} (${f.error})`).join("; ")}` : ""}` });
      home.reload();
    });

  const borrow = (a: HomeAgent) =>
    act(async () => {
      setBack(null);
      const r = await api("home/borrow", { body: { agent: a.id } });
      setCopied(false);
      setBorrowed({ name: r.agent.name, version: r.agent.version, text: r.text, truncated: r.truncated });
    });

  const previewBack = (agent: HomeAgent, copy: Copy, choices: Record<string, "home" | "incoming"> = {}) =>
    act(async () => {
      setBorrowed(null);
      setConfirm(false);
      const preview = await api("home/send-back", { body: { agent: agent.id, from: { adapter: copy.adapter, root: copy.root, nativeId: copy.nativeId }, prefer: choices } });
      setPrefer(choices);
      setBack({ agent, copy, preview });
    });

  const applyBack = () =>
    act(async () => {
      if (!back) return;
      const r = await api("home/send-back/apply", { body: { previewId: back.preview.id, token: back.preview.token } });
      setMsg({ tone: "ok", text: `${r.agent.name} is now version ${r.version} in your home (${r.added} added, ${r.updated} updated).${r.behind.length ? ` Behind the home now: ${r.behind.map((c: Copy) => c.app).join(", ")}.` : ""}` });
      setBack(null);
      home.reload();
    });

  const copy = async () => {
    if (!borrowed) return;
    try {
      await navigator.clipboard.writeText(borrowed.text);
      setCopied(true);
    } catch {
      setMsg({ tone: "bad", text: "Could not copy. Select the text and copy it yourself." });
    }
  };

  const agents = home.data?.agents ?? [];
  const waiting = home.data?.notInHomeYet ?? [];
  const changes: Change[] = back?.preview.changes ?? [];
  const shown = changes.filter((c) => c.action !== "skip");
  const unresolved = changes.filter((c) => c.action === "conflict" && !prefer[c.key]);

  return (
    <>
      <PageHead title="Your Nomad" sub="Every agent you have, in one home. Use one in any chat, install it in an app, and bring what it learns back.">
        {waiting.length > 0 && (
          <button className="btn" disabled={busy} onClick={gather}>
            Gather {waiting.length} agent{waiting.length === 1 ? "" : "s"}
          </button>
        )}
      </PageHead>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {home.error && <Notice tone="bad">{home.error.message}</Notice>}
      {waiting.length > 0 && (
        <Notice title="Not in your home yet">
          {waiting.map((w) => `${w.name} (${w.app})`).join(", ")}. Gather them to use them from any app; their apps are only read.
        </Notice>
      )}

      {home.loading && !home.data ? (
        <Skeleton rows={4} />
      ) : !agents.length ? (
        <Empty title="Your home is empty">
          Gather the agents in your apps, or <Link href="/app/import">import a package</Link>.
        </Empty>
      ) : (
        <div className="panel table-wrap" style={{ marginTop: 16 }}>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Lives in</th>
                <th scope="col">Version</th>
                <th scope="col">Memory</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/app/agents/view?id=${a.id}`} style={{ fontWeight: 600 }}>
                      {a.name}
                    </Link>{" "}
                    {a.fromOthers && <Badge kind="warn">from others</Badge>}
                    {a.description && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        {a.description}
                      </div>
                    )}
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Updated {formatDate(a.updatedAt)}
                    </div>
                  </td>
                  <td>
                    {a.copies.length ? (
                      <div className="stack" style={{ gap: 6 }}>
                        {a.copies.map((c) => (
                          <div key={`${c.adapter}:${c.root}#${c.nativeId}`}>
                            <Badge kind={c.behind ? "warn" : "neutral"}>{c.behind ? `${c.app}, behind` : c.app}</Badge>{" "}
                            <button className="link-btn" disabled={busy} onClick={() => previewBack(a, c)}>
                              Bring changes home
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">Home only</span>
                    )}
                  </td>
                  <td>v{a.version}</td>
                  <td>{a.memoryEntries ? `${a.memoryEntries} entries` : <span className="muted">None</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => borrow(a)}>
                      Borrow
                    </button>{" "}
                    <Link href={`/app/migrate?agent=${a.id}`} className="btn btn-sm">
                      Send to an app
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {borrowed && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h3>
              Borrow {borrowed.name} (v{borrowed.version})
            </h3>
            <div className="row">
              <button className="btn btn-sm" onClick={copy}>
                {copied ? "Copied" : "Copy text"}
              </button>
              <button className="btn btn-quiet btn-sm" onClick={() => setBorrowed(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="panel-body stack">
            <p className="muted">Paste this into any chat, including Claude or ChatGPT on the web, to work with {borrowed.name} there. Nothing was written. Secrets are left out.{borrowed.truncated ? " Some of it was shortened." : ""}</p>
            <textarea className="input" readOnly rows={16} value={borrowed.text} aria-label={`${borrowed.name} as text`} style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.85rem" }} />
          </div>
        </div>
      )}

      {back && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h3>
              Bring changes home: {back.agent.name} from {back.copy.app}
            </h3>
            <button className="btn btn-quiet btn-sm" onClick={() => setBack(null)}>
              Close
            </button>
          </div>
          <div className="panel-body stack">
            <p className="muted">
              Read from {back.copy.display}; the app&apos;s files are not changed. Nothing is deleted from your home, and a new version can be undone from Versions.
            </p>
            {shown.length ? (
              shown.map((c) => (
                <div key={c.key}>
                  <Badge kind={c.action === "add" ? "ok" : c.action === "update" ? "info" : "warn"}>{c.action === "conflict" ? "changed in both" : c.action}</Badge> {c.category}: <strong>{c.label}</strong>
                  {c.action === "conflict" ? (
                    <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                      <label className="check">
                        <input type="radio" name={c.key} checked={prefer[c.key] === "home"} onChange={() => setPrefer({ ...prefer, [c.key]: "home" })} />
                        <span>Keep the home: {c.home}</span>
                      </label>
                      <label className="check">
                        <input type="radio" name={c.key} checked={prefer[c.key] === "incoming"} onChange={() => setPrefer({ ...prefer, [c.key]: "incoming" })} />
                        <span>
                          Use {back.copy.app}: {c.incoming}
                        </span>
                      </label>
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: "0.85rem" }}>
                      {c.incoming}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p>Nothing new: your home already has everything this copy has.</p>
            )}
            {back.preview.notes
              .filter((n: string) => !n.startsWith("Nothing new"))
              .map((n: string) => (
              <Notice key={n} tone="warn">
                {n}
              </Notice>
            ))}
            {changes.some((c) => c.action === "conflict") && (
              <div>
                <button className="btn btn-quiet btn-sm" disabled={busy || unresolved.length > 0} onClick={() => previewBack(back.agent, back.copy, prefer)}>
                  Use these choices
                </button>
              </div>
            )}
            {back.preview.summary.add + back.preview.summary.update > 0 && !back.preview.summary.unresolved && (
              <>
                <label className="check">
                  <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                  <span>{saveLabel(back.preview.summary.add, back.preview.summary.update, back.agent.name)}</span>
                </label>
                <div>
                  <button className="btn" disabled={!confirm || busy} onClick={applyBack}>
                    Save to my home
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h3>Apps with Nomad</h3>
        </div>
        <div className="panel-body stack">
          {apps.loading && !apps.data ? (
            <Skeleton rows={2} />
          ) : (
            <div className="tag-list">
              {(apps.data ?? [])
                .filter((x) => x.detected || x.connected)
                .map((x) => (
                  <Badge key={x.app} kind={x.connected ? "ok" : "neutral"}>
                    {x.displayName}: {x.connected ? (x.writes ? "connected" : "connected, read only") : "not connected"}
                  </Badge>
                ))}
            </div>
          )}
          <p className="muted">
            To reach your home from inside an app, run <code>nomad connect</code> in a terminal. Then ask the app: &quot;Nomad, show my agents&quot;.
          </p>
        </div>
      </div>
    </>
  );
}
