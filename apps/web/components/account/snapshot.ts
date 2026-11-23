/**
 * The last thing a signed-in person saw on their account page, kept on their own device, so the page shows it at
 * once on the next visit while the sign-in and the chain catch up. Nothing secret: balances, credits, agent names.
 */
export type Snapshot = { address: string; nomad: string; usdg: string; usd: string; credits: string | null; agents: { name: string; status: string }[]; at: number };

const KEY = "nomad:account-snapshot";

export function readSnapshot(): Snapshot | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Snapshot | null;
    return s && typeof s.address === "string" ? s : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(part: Partial<Snapshot>) {
  try {
    const prev = readSnapshot();
    localStorage.setItem(KEY, JSON.stringify({ address: "", nomad: "...", usdg: "...", usd: "", credits: null, agents: [], ...prev, ...part, at: Date.now() }));
  } catch {
    /* storage unavailable: the page still works, only without the instant view */
  }
}

export function clearSnapshot() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
