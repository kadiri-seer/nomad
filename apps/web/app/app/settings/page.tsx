"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "@/lib/client";
import { Notice, PageHead, Skeleton } from "@/components/ui";

type UpdateState = { installed: boolean; current?: string; latest?: string; available?: boolean; updated?: boolean; error?: string };

async function updateCall(method: "GET" | "POST", check = false): Promise<UpdateState | null> {
  const res = await fetch(`/api/app/update${check ? "?check=1" : ""}`, { method, headers: { "x-nomad": "1" }, credentials: "same-origin", cache: "no-store" });
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return null;
  const data = (await res.json()) as UpdateState;
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Shown only when Nomad was installed from thenomad.website. Contacts GitHub only when asked. */
function Updates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<"check" | "update" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useEffect(() => {
    updateCall("GET")
      .then(setState)
      .catch(() => setState(null));
  }, []);
  if (!state?.installed) return null;

  const go = async (kind: "check" | "update") => {
    setBusy(kind);
    setMsg(null);
    try {
      const r = await updateCall(kind === "check" ? "GET" : "POST", kind === "check");
      if (!r) throw new Error("This dashboard cannot update Nomad.");
      setState(r);
      if (kind === "check" && !r.available) setMsg({ tone: "ok", text: `Nomad is up to date (${r.current}).` });
      if (kind === "update" && r.updated) setMsg({ tone: "ok", text: `Updated to Nomad ${r.current}. Close the Nomad window and open Nomad again to use it.` });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Updates</h3>
      </div>
      <div className="panel-body stack">
        <p className="muted">
          You have Nomad {state.current}. Checking asks GitHub for the newest release, only when you press the button. Updates are checked against their published fingerprint before anything changes.
        </p>
        <div className="row">
          {state.available && !state.updated ? (
            <button className="btn" onClick={() => go("update")} disabled={busy !== null}>
              {busy === "update" ? "Updating..." : `Update to ${state.latest}`}
            </button>
          ) : (
            <button className="btn" onClick={() => go("check")} disabled={busy !== null || !!state.updated}>
              {busy === "check" ? "Checking..." : "Check for updates"}
            </button>
          )}
        </div>
        {state.available && !state.updated && !msg && <Notice tone="ok">Nomad {state.latest} is available.</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </div>
  );
}

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
          <Updates />
        </div>
      ) : null}
    </>
  );
}
