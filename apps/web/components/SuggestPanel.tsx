"use client";

import { useEffect, useState } from "react";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? ((await res.json()) as Record<string, unknown>) : {};
  return { ok: res.ok, data };
}

/** The suggestion box. Suggestions are sent for review and are not listed on the page. */
export function SuggestPanel() {
  const [available, setAvailable] = useState(true);
  const [name, setName] = useState("");
  const [why, setWhy] = useState("");
  const [trap, setTrap] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    // The local app has no suggestion service, so the box only shows where one answers.
    fetch("/api/suggest", { method: "HEAD", cache: "no-store" })
      .then((res) => {
        if (!(res.headers.get("content-type") ?? "").includes("application/json")) setAvailable(false);
      })
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    try {
      const r = await post("/api/suggest", { name, why, website: trap });
      if (!r.ok) {
        setNotice({ kind: "bad", text: String(r.data.error ?? "Your suggestion was not sent. Try again.") });
      } else {
        setNotice({ kind: "ok", text: "Sent. Thanks for your suggestion." });
        setName("");
        setWhy("");
      }
    } catch {
      setNotice({ kind: "bad", text: "Your suggestion was not sent. Check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="suggest" aria-labelledby="suggest-title">
      <h2 id="suggest-title">Suggest an app</h2>
      <p className="muted">Which app should Nomad move agents to and from next? Anyone can suggest one. Suggestions the maintainers accept go on the next ballot.</p>
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
    </section>
  );
}
