"use client";

import { useState } from "react";
import { api, useApi } from "@/lib/client";
import { Notice, PageHead, Skeleton } from "@/components/ui";

export default function SettingsPage() {
  const s = useApi<Record<string, any>>("settings");
  const [extra, setExtra] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const save = async () => {
    setMsg(null);
    try {
      const roots = extra
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [adapter, ...rest] = l.split(":");
          return { adapter, root: rest.join(":") };
        });
      for (const r of roots) if (!r.adapter || !r.root) throw new Error(`Use the form platform:folder, for example cursor:~/work/app`);
      await api("settings", { body: { extraRoots: roots } });
      setMsg({ tone: "ok", text: "Saved." });
      s.reload();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    }
  };

  return (
    <>
      <PageHead title="Settings" sub="Nomad keeps everything on this machine." />
      {s.loading && !s.data ? (
        <Skeleton rows={3} />
      ) : s.data ? (
        <div className="stack" style={{ maxWidth: 760 }}>
          <div className="panel">
            <div className="panel-head">
              <h3>Storage</h3>
            </div>
            <dl className="kv panel-body">
              <dt>Data folder</dt>
              <dd>
                <code className="break">{s.data.home}</code>
              </dd>
              <dt>Contents</dt>
              <dd>Library database, agent versions, backups, exports and uploaded packages. Set NOMAD_HOME to move it.</dd>
              <dt>Cloud</dt>
              <dd>None. Nomad has no account and sends nothing anywhere.</dd>
            </dl>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Extra locations</h3>
            </div>
            <div className="panel-body stack">
              <p className="muted">Folders to include when scanning, one per line as platform:folder. Useful for project based tools such as Cursor.</p>
              <textarea
                className="input"
                rows={4}
                placeholder="cursor:~/work/my-app"
                defaultValue={(s.data.extraRoots ?? []).map((r: any) => `${r.adapter}:${r.root}`).join("\n")}
                onChange={(e) => setExtra(e.target.value)}
                style={{ fontFamily: "var(--mono)", fontSize: "0.9rem" }}
              />
              <div>
                <button className="btn" onClick={save}>
                  Save
                </button>
              </div>
              {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
