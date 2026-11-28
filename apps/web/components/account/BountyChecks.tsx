"use client";

/** Shared pieces of the bounty screens: a short list of checks with marks, and a copyable block of text. */
import type { Check } from "@/lib/bounties/shared";
import { CopyButton } from "../CopyButton";

export function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="check-list">
      {checks.map((c) => (
        <li key={c.name} className={c.ok ? "check-ok" : "check-bad"}>
          <Mark ok={c.ok} />
          <span>
            <strong>{c.name}</strong>
            {c.detail && <span className="acct-small">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return (
    <svg className="check-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label={ok ? "Passed" : "Did not pass"} role="img">
      {ok ? <path d="M5 12.5l4.5 4.5L19 7" /> : <path d="M7 7l10 10M17 7L7 17" />}
    </svg>
  );
}

/** A block of text to copy exactly, such as a message to sign or a command. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="copy-block">
      <div className="acct-between">
        <span className="acct-small">{label}</span>
        <CopyButton text={text} className="acct-quiet" />
      </div>
      <pre>{text}</pre>
    </div>
  );
}
