import type { Capability, PermissionPolicy, PermissionRule } from "@nomad/schema";

const MODE_RANK = { "read-only": 0, ask: 1, auto: 2 } as const;
const EFFECT_RANK = { deny: 0, ask: 1, allow: 2 } as const;
const CAPS: Capability[] = ["read", "write", "file", "shell", "network", "browser", "computer", "schedule", "tool", "integration"];

function blanket(rules: PermissionRule[], cap: Capability): number {
  const r = rules.filter((x) => x.capability === cap && !x.pattern);
  if (!r.length) return 1; // platform default, treated as "ask"
  return Math.min(...r.map((x) => EFFECT_RANK[x.effect]));
}

const key = (r: PermissionRule) => `${r.capability}|${r.pattern ?? ""}`;

/**
 * Find every way `after` is more permissive than `before`. Used to make sure a
 * migration never silently widens what an agent may do at the destination.
 */
export function widenedPermissions(before: PermissionPolicy | null, after: PermissionPolicy | null): string[] {
  const b = before ?? { mode: "ask", rules: [], notes: [] };
  const a = after ?? { mode: "ask", rules: [], notes: [] };
  const out: string[] = [];
  if (MODE_RANK[a.mode] > MODE_RANK[b.mode]) out.push(`Approval mode changes from ${b.mode} to ${a.mode}`);
  for (const cap of CAPS) {
    const rb = blanket(b.rules, cap);
    const ra = blanket(a.rules, cap);
    if (ra > rb) out.push(`${cap}: ${["deny", "ask", "allow"][rb]} becomes ${["deny", "ask", "allow"][ra]}`);
  }
  const beforeAllow = new Set(b.rules.filter((r) => r.effect === "allow" && r.pattern).map(key));
  for (const r of a.rules.filter((r) => r.effect === "allow" && r.pattern)) {
    if (!beforeAllow.has(key(r))) out.push(`New allow rule: ${r.capability} ${r.pattern}`);
  }
  const afterRestrict = new Map(a.rules.filter((r) => r.pattern).map((r) => [key(r), r.effect]));
  for (const r of b.rules.filter((r) => r.effect !== "allow" && r.pattern)) {
    const now = afterRestrict.get(key(r));
    if (!now || EFFECT_RANK[now] > EFFECT_RANK[r.effect]) out.push(`Removed ${r.effect} rule: ${r.capability} ${r.pattern}`);
  }
  return [...new Set(out)];
}

/** Restrictions in the source that the destination policy does not enforce. */
export function unenforcedRestrictions(source: PermissionPolicy, destination: PermissionPolicy | null): string[] {
  const d = destination ?? { mode: "ask", rules: [], notes: [] };
  const out: string[] = [];
  if (source.mode === "read-only" && d.mode !== "read-only" && blanket(d.rules, "write") > 0) out.push("Read-only mode");
  for (const cap of CAPS) {
    const rs = source.rules.filter((r) => r.capability === cap && !r.pattern && r.effect !== "allow");
    if (!rs.length) continue;
    const want = Math.min(...rs.map((r) => EFFECT_RANK[r.effect]));
    if (blanket(d.rules, cap) > want) out.push(`${["deny", "ask"][want]} ${cap}`);
  }
  return out;
}
