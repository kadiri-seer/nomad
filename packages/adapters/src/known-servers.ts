import type { Note, UnsupportedItem } from "@nomad/core";
import type { Tool } from "@nomad/schema";

/**
 * Profiles for MCP servers whose configuration needs care when it moves:
 * which variables are keys, which are identity, which are safety limits.
 * Profiles only remove or explain; they never add variables the source did
 * not have and never write values.
 */
export interface KnownServerProfileResult {
  tool: Tool;
  notes: Note[];
  manualSteps: string[];
  unsupported: UnsupportedItem[];
}

interface ServerProfile {
  id: string;
  /** The service's name, used in messages such as "the destination uses Priors defaults". */
  vendor: string;
  label: string;
  matches: (t: Tool) => boolean;
  /** Key variables. Set exactly one; the server refuses both at once. */
  keyVars: string[];
  /** Identity variables that may be empty. */
  emptyOkEnv: string[];
  /** Safety limits: carried only as literal values. */
  limitVars: string[];
  /** Limits whose default is much looser than any value a user would set. */
  looserDefaults: Record<string, string>;
  apply?: (t: Tool, out: KnownServerProfileResult, platform: string) => void;
}

const isPriorsHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    return new URL(url).hostname === "mcp.priors.trade";
  } catch {
    return false;
  }
};

const PRIORS: ServerProfile = {
  id: "priors",
  vendor: "Priors",
  label: "Priors (a credit service for agents on Robinhood Chain)",
  matches: (t) => !!t.mcp && (t.mcp.command === "priors-mcp" || t.mcp.args.some((a) => a.includes("@priors/mcp")) || isPriorsHost(t.mcp.url)),
  keyVars: ["PRIORS_KEY_FILE", "PRIORS_KEY"],
  emptyOkEnv: ["PRIORS_AGENT_ID"],
  limitVars: [
    "PRIORS_PAY_HOSTS",
    "PRIORS_OWNER_ENTITY_IDS",
    "PRIORS_MAX_PRICE_USD",
    "PRIORS_MAX_SPEND_USD",
    "PRIORS_MAX_BORROW_USD",
    "PRIORS_MAX_BORROW_TOTAL_USD",
    "PRIORS_MAX_SPEND_DAY_USD",
    "PRIORS_MAX_BORROW_DAY_USD",
    "PRIORS_AUTO_BORROW_USD",
    "PRIORS_STATE_DIR"
  ],
  looserDefaults: {
    PRIORS_PAY_HOSTS: "defaults are looser: any public https host",
    PRIORS_MAX_SPEND_DAY_USD: "defaults are looser: no daily caps",
    PRIORS_MAX_BORROW_DAY_USD: "defaults are looser: no daily caps"
  },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    if (mcp.transport !== "stdio") {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" is a remote server run by a third party (Priors). Nomad copies only its address.` });
      return;
    }
    out.notes.push({
      level: "info",
      category: "integrations",
      message: "Priors on-chain items (the ERC-8004 identity, the credit line, open loans, Autopay enrolment, the declared agent wallet) stay with the wallet. Moving the agent does not move or repay them."
    });
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}": daily spend and borrow counters start again on ${platform}. Give every client that uses this agent's key the same limits (Priors counts per state folder).`
    });
    if (mcp.command === "priors-mcp") {
      out.manualSteps.push(`Install the Priors MCP server for "${t.name}": npm install -g @priors/mcp@<version you trust>. It needs Node.js 20.10 or later on the PATH ${platform} uses.`);
    }
    const keyFileArgs = mcp.args.filter((a) => /\.key$/i.test(a) || /(^|\/)\.config\/priors(\/|$)/.test(a));
    for (const a of keyFileArgs) {
      out.manualSteps.push(`Create the key file ${a} on this machine (owner-only, chmod 600) for "${t.name}". Nomad did not copy it.`);
      out.unsupported.push({ category: "tools", item: `${t.name}: key file referenced in launch arguments (${a})`, reason: "Key files are never read or copied.", alternative: "Create the key file on the new machine (owner-only) with a dedicated wallet." });
    }
  }
};

/** The oak command (also oak.cmd or oak.exe on Windows), alone or as a path. */
const isOakCommand = (command: string | undefined) => !!command && /(^|[\\/])oak(\.cmd|\.exe)?$/i.test(command);

/**
 * Oak Agent Kit, as Oak documents it (github.com/OakAgentKit/oak and the
 * @oakagentkit/addon 0.3.8 package, read Nov 14, 2026): one local MCP server,
 * started as `oak mcp` or `npx -y @oakagentkit/addon@<version> mcp`, or from the
 * Claude Code plugin oak@oak-agent-kit. Its wallet, settings and keychain entry
 * live in ~/.oak and the system keychain, never in the MCP entry.
 */
const OAK: ServerProfile = {
  id: "oak",
  vendor: "Oak",
  label: "Oak Agent Kit (a local wallet and tools for Robinhood Chain projects)",
  matches: (t) => !!t.mcp && t.mcp.transport === "stdio" && ((isOakCommand(t.mcp.command) && t.mcp.args[0] === "mcp") || t.mcp.args.some((a) => /^@oakagentkit\/addon(@|$)/.test(a))),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: ["OAK_AUTO_DAILY_CAP_USD"],
  looserDefaults: { OAK_AUTO_DAILY_CAP_USD: "50 USD a day for automatic approvals" },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    out.notes.push({
      level: "info",
      category: "integrations",
      message: "Oak's wallet, its settings (including the approval mode and the daily budget) and its keychain entry stay on this computer, in ~/.oak and the system keychain. Nomad never reads ~/.oak."
    });
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Oak: if ${platform} runs on another computer, Oak creates a new, empty wallet there the first time it starts. To keep the same wallet, restore it there yourself, in your own terminal and never through an agent, following Oak's backup guide (oak backup).`
    });
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Oak: Oak asks for approval in the app before it signs. Oak's documentation says apps without MCP form elicitation cannot sign in its default ask mode, so check that ${platform} shows Oak's approval form before relying on it.`
    });
    if (isOakCommand(mcp.command)) {
      out.manualSteps.push(`Install Oak for "${t.name}": npm install -g @oakagentkit/addon. It needs Node.js 22.12 or later, and the oak command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs Oak through npx: ${platform} needs Node.js 22.12 or later on its PATH.`);
    }
    for (const k of ["OAK_NETWORK", "OAK_CHAIN_ID"]) {
      const v = mcp.env[k];
      if (v && !("value" in v)) {
        out.notes.push({ level: "warning", category: "tools", message: `"${t.name}": ${k} is a reference. Set it on ${platform} too; without it Oak uses Robinhood Chain mainnet.` });
      }
    }
  }
};

const PROFILES: ServerProfile[] = [PRIORS, OAK];

/** Apply the profile of a known server, if any. Returns a copy; the input is not changed. */
export function applyKnownServerProfile(tool: Tool, platformName = "the destination"): KnownServerProfileResult {
  const out: KnownServerProfileResult = { tool, notes: [], manualSteps: [], unsupported: [] };
  const profile = tool.mcp ? PROFILES.find((p) => p.matches(tool)) : undefined;
  if (!profile || !tool.mcp) return out;
  const env = { ...tool.mcp.env };
  const optional = new Set(((tool.mcp as Record<string, unknown>).optionalEnv as string[] | undefined) ?? []);

  const keys = profile.keyVars.filter((k) => env[k]);
  if (keys.length > 1) {
    for (const k of keys) delete env[k];
    out.manualSteps.push(
      `"${tool.name}" listed both ${keys.join(" and ")}, which ${profile.id === "priors" ? "Priors" : "the server"} refuses together, so Nomad wrote neither. Set one: ${keys[0]} (recommended: a path to an owner-only key file, chmod 600, for a dedicated wallet) or ${keys[1]}.`
    );
  }
  for (const k of profile.keyVars) {
    if (keys.includes(k)) {
      out.unsupported.push({ category: "tools", item: `${tool.name}: ${k}`, reason: "Wallet keys and key files are references only.", alternative: "Create the key file on the new machine (owner-only) and set the variable. Use a dedicated wallet." });
    }
  }

  for (const k of profile.limitVars) {
    const v = env[k];
    if (!v || "value" in v) continue;
    delete env[k];
    optional.delete(k);
    const looser = profile.looserDefaults[k];
    out.unsupported.push({
      category: "permissions",
      item: `${tool.name}: ${k}`,
      reason: `Limit not carried: it was a reference on the source, so the destination uses ${profile.vendor} defaults${looser ? ` (${looser})` : ""}.`,
      alternative: `Set ${k} on the destination to keep the limit.`
    });
  }

  const mcp: Record<string, unknown> = { ...tool.mcp, env };
  const keptOptional = [...optional].filter((k) => env[k]);
  if (keptOptional.length) mcp.optionalEnv = keptOptional;
  else delete mcp.optionalEnv;
  if (profile.emptyOkEnv.length) mcp.emptyOkEnv = profile.emptyOkEnv;
  out.tool = { ...tool, mcp: mcp as Tool["mcp"] };
  profile.apply?.(out.tool, out, platformName);
  return out;
}

/** True when a tool belongs to a known server (used by previews and docs). */
export function knownServerId(tool: Tool): string | null {
  return PROFILES.find((p) => p.matches(tool))?.id ?? null;
}
