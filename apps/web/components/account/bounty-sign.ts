/** Sends one signed bounty step (review or sponsor) from the account page. The sign-in wallet signs without a prompt. */
import { entrantMessage, reviewMessage, sponsorMessage } from "@/lib/bounties/shared";
import type { Client } from "./types";

export async function signedStep<T = Record<string, unknown>>(client: Client, kind: "review" | "sponsor" | "entrant", label: string, body: Record<string, unknown>): Promise<T> {
  const at = Date.now();
  const message = kind === "review" ? reviewMessage(label, at) : kind === "sponsor" ? sponsorMessage(label, at) : entrantMessage(label, at);
  const signature = await client.owner.signMessage({ message });
  const r = await fetch(`/api/bounties/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signer: client.signer, ...body, at, signature })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "That did not go through.");
  return j as T;
}

export const fail = (e: unknown) => window.dispatchEvent(new CustomEvent("nomad-account-error", { detail: (e as Error)?.message ?? "Something went wrong." }));
export const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
export const DAY_MS = 86_400_000;
export const utcDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const utcTime = (iso: string) => new Date(iso).toISOString().slice(11, 16);
export const daysOf = (b: { opens: string; closes: string }) => Math.round((Date.parse(b.closes) - Date.parse(b.opens)) / DAY_MS);
/** "30 Nov 2026, 15:00 UTC for 10 days" */
export const scheduleLine = (opens: string, days: number) => `${utcDay(opens)}, ${utcTime(opens)} UTC for ${days} ${days === 1 ? "day" : "days"}`;
