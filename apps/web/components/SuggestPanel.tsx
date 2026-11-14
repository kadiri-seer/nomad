"use client";

import { useCallback, useEffect, useState } from "react";
import { REPO_URL } from "@/components/SiteFooter";

type Item = { issue: number; name: string; approved: boolean; won: boolean; thumbs: number; support: number; source: "site" | "github" };

const BACKED_KEY = "nomad-backed-suggestions";

function readBacked(): number[] {
  try {
    const raw = window.localStorage.getItem(BACKED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function rememberBacked(list: number[]) {
  try {
    window.localStorage.setItem(BACKED_KEY, JSON.stringify(list));
  } catch {
    /* only a convenience: the server already counts one back per person */
  }
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? ((await res.json()) as Record<string, unknown>) : {};
  return { ok: res.ok, data };
}

export function SuggestPanel() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [name, setName] = useState("");
  const [why, setWhy] = useState("");
  const [trap, setTrap] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [backed, setBacked] = useState<number[]>([]);
  const [backing, setBacking] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/suggest", { cache: "no-store" });
      if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
        setAvailable(false);
        return;
      }
      const data = (await res.json()) as { items?: Item[] };
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    setBacked(readBacked());
    load();
  }, [load]);

  if (!available) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    try {
      const r = await post("/api/suggest", { name, why, website: trap });
      if (!r.ok) {
        setNotice({ kind: "bad", text: String(r.data.error ?? "Your suggestion was not sent. Try again.") });
      } else if (r.data.status === "duplicate") {
        const issue = typeof r.data.issue === "number" ? r.data.issue : null;
        setNotice({ kind: "ok", text: issue ? `Someone already suggested that. Back it in the list below to move it up.` : "Someone already suggested that. It will appear in the list within an hour." });
        setName("");
        setWhy("");
      } else {
        setNotice({ kind: "ok", text: "Thanks. Your suggestion will appear in the list within an hour, once it is posted on GitHub." });
        setName("");
        setWhy("");
      }
    } catch {
      setNotice({ kind: "bad", text: "Your suggestion was not sent. Check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  async function back(issue: number) {
    setBacking(issue);
    try {
      const r = await post("/api/suggest/back", { issue });
      if (r.ok) {
        const next = [...new Set([...backed, issue])];
        setBacked(next);
        rememberBacked(next);
        setItems((list) => list?.map((it) => (it.issue === issue ? { ...it, support: Number(r.data.support ?? it.support) } : it)) ?? null);
      } else {
        setNotice({ kind: "bad", text: String(r.data.error ?? "That did not go through. Try again.") });
      }
    } catch {
      setNotice({ kind: "bad", text: "That did not go through. Check your connection and try again." });
    } finally {
      setBacking(null);
    }
  }

  return (
    <section className="suggest" aria-labelledby="suggest-title">
      <h2 id="suggest-title">Suggest an app</h2>
      <p className="muted">Which app should Nomad move agents to and from next? Anyone can suggest one. Suggestions the maintainers accept go on the next ballot, most backed first.</p>
      <form className="panel panel-body suggest-form" onSubmit={submit}>
        <label>
          <span>App or tool</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="For example: Claude Desktop" autoComplete="off" />
        </label>
        <label>
          <span>
            Why it should be next <span className="muted">(optional)</span>
          </span>
          <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} rows={3} placeholder="Who uses it and what moving agents in or out of it would let them do." />
        </label>
        <label className="suggest-trap" aria-hidden="true">
          Website
          <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </label>
        <div className="suggest-actions">
          <button type="submit" className="btn" disabled={sending || name.trim().length < 2}>
            {sending ? "Sending…" : "Send suggestion"}
          </button>
          <span className="muted">Do not include keys, passwords or private files.</span>
        </div>
        {notice && <p className={`vote-notice ${notice.kind}`}>{notice.text}</p>}
      </form>

      <h3 className="suggest-list-title">Suggestions</h3>
      {items === null ? (
        <p className="muted">Loading suggestions…</p>
      ) : items.length === 0 ? (
        <p className="muted">No suggestions yet. Be the first.</p>
      ) : (
        <ul className="suggest-list">
          {items.map((it) => {
            const mine = backed.includes(it.issue);
            return (
              <li key={it.issue}>
                <span className="suggest-name">
                  {it.name}{" "}
                  <a href={`${REPO_URL}/issues/${it.issue}`} className="muted">
                    #{it.issue}
                  </a>
                </span>
                <span className="suggest-tags">
                  {it.won ? <span className="badge ok">Won a vote</span> : it.approved ? <span className="badge info">Accepted</span> : <span className="badge not-applicable">Waiting for review</span>}
                </span>
                <span className="suggest-count">{it.thumbs + it.support} backing</span>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => back(it.issue)} disabled={mine || backing === it.issue || it.won}>
                  {mine ? "Backed" : "Back this"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
