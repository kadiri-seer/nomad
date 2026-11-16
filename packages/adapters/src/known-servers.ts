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

/**
 * An npm package as npx runs it: the exact name, optionally with a version, range or tag. Nothing after it,
 * and no URL or git spec, so a look-alike ("@priors/mcp-evil", "x@priors/mcp", "pkg@https://…") is not the package.
 */
const NPM_SPEC = "(@[0-9A-Za-z.^~*+-]{1,64})?";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isPackageArg = (name: string) => {
  const re = new RegExp(`^${escapeRe(name)}${NPM_SPEC}$`);
  return (a: string) => re.test(a);
};
/** The same package named as one word inside a shell script (Priors documents an `sh -c '… exec npx -y @priors/mcp@…'` wrapper). */
const isPackageInScript = (name: string) => {
  const re = new RegExp(`(^|\\s)${escapeRe(name)}${NPM_SPEC}(\\s|$)`);
  return (a: string) => re.test(a);
};
const isPriorsPackage = isPackageArg("@priors/mcp");
const isPriorsScript = isPackageInScript("@priors/mcp");

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
  matches: (t) =>
    !!t.mcp &&
    (t.mcp.command === "priors-mcp" ||
      t.mcp.args.some(isPriorsPackage) ||
      (/(^|[\\/])(ba|z)?sh(\.exe)?$/.test(t.mcp.command ?? "") && t.mcp.args.some(isPriorsScript)) ||
      isPriorsHost(t.mcp.url)),
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
  matches: (t) => !!t.mcp && t.mcp.transport === "stdio" && ((isOakCommand(t.mcp.command) && t.mcp.args[0] === "mcp") || t.mcp.args.some(isPackageArg("@oakagentkit/addon"))),
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

const HEDGEHOOD_HOSTS = new Set(["mcp.hedgehood.io", "testnet-mcp.hedgehood.io"]);
const isHedgehoodHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    return HEDGEHOOD_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};
/** The hedgehood-mcp command from @hedgehood-io/mcp (also .cmd or .exe on Windows), alone or as a path. */
const isHedgehoodCommand = (command: string | undefined) => !!command && /(^|[\\/])hedgehood-mcp(\.cmd|\.exe)?$/i.test(command);
const HEDGEHOOD_KEY_VARS = ["HEDGEHOOD_SESSION_KEY_FILE", "HEDGEHOOD_SESSION_KEY", "HEDGEHOOD_PAYER_KEY_FILE", "HEDGEHOOD_PAYER_KEY", "HEDGEHOOD_OWNER_KEY_FILE", "HEDGEHOOD_OWNER_KEY"];

/**
 * Hedgehood, an options market for AI agents on Robinhood Chain, as Hedgehood documents it
 * (github.com/0xHedgeHood/hedgehood-agent-kit and @hedgehood-io/mcp 0.5.1, read Nov 15, 2026):
 * the local server `npx -y @hedgehood-io/mcp` or `hedgehood-mcp`, the Claude Code plugin
 * hedgehood-options@hedgehood, and the hosted read-only servers. Keys are files in ~/.hedgehood
 * (or raw keys in the environment); unset settings fall back to ~/.hedgehood/config.json, then to testnet.
 */
const HEDGEHOOD: ServerProfile = {
  id: "hedgehood",
  vendor: "Hedgehood",
  label: "Hedgehood (an options market for AI agents on Robinhood Chain)",
  matches: (t) => !!t.mcp && (isHedgehoodCommand(t.mcp.command) || t.mcp.args.some(isPackageArg("@hedgehood-io/mcp")) || isHedgehoodHost(t.mcp.url)),
  // Both the file and the raw form of a key may be set (the file wins), so keys are handled in apply().
  keyVars: [],
  emptyOkEnv: [],
  limitVars: ["HEDGEHOOD_MAX_DEPOSIT", "HEDGEHOOD_DRY_RUN"],
  looserDefaults: { HEDGEHOOD_MAX_DEPOSIT: "1000 USDG per deposit", HEDGEHOOD_DRY_RUN: "write tools only simulate" },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    if (mcp.transport !== "stdio") {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" is a read-only server run by Hedgehood, with no keys. Nomad copies only its address.` });
      return;
    }
    out.notes.push({
      level: "info",
      category: "integrations",
      message: "Hedgehood's keys and settings stay on this computer in ~/.hedgehood (the session, payer and owner key files and config.json). Nomad never reads that folder or any key file, and never moves positions, balances or sessions on chain."
    });
    // A raw key (not a file path) is a wallet private key: never written as a value, even with --include-secrets.
    for (const k of ["HEDGEHOOD_SESSION_KEY", "HEDGEHOOD_PAYER_KEY", "HEDGEHOOD_OWNER_KEY"]) {
      const v = mcp.env[k];
      if (v && "value" in v) mcp.env[k] = { secretRef: k, redacted: true };
    }
    for (const k of HEDGEHOOD_KEY_VARS) {
      if (!mcp.env[k]) continue;
      out.unsupported.push({
        category: "tools",
        item: `${t.name}: ${k}`,
        reason: "Hedgehood keys and key files are references only; Nomad never reads or copies them.",
        alternative: k.includes("SESSION")
          ? "On this computer, keep the key file where it is (owner-only, chmod 600) and set the variable. On another computer, create a new session key there."
          : "Set it on the destination only if this agent needs it."
      });
    }
    if (mcp.env.HEDGEHOOD_OWNER_KEY_FILE || mcp.env.HEDGEHOOD_OWNER_KEY) {
      out.notes.push({
        level: "warning",
        category: "tools",
        message: `"${t.name}" was given the owner key. The owner key can withdraw funds and manage sessions; Hedgehood says to keep it off shared machines. Set it on ${platform} only if this agent really needs it.`
      });
    }
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Hedgehood: if ${platform} runs on another computer, the session key does not come along. Run hedgehood init (or hedgehood join) there in your own terminal, have the owner authorize the new session with a spending budget, and revoke the old session if it will no longer be used (with the owner key: hedgehood session revoke <old session address> --send).`
    });
    const chain = mcp.env.HEDGEHOOD_CHAIN_ID;
    const mainnetFlag = mcp.args.includes("--mainnet");
    const testnetFlag = mcp.args.includes("--testnet");
    if (mainnetFlag || (chain && "value" in chain && chain.value.trim() === "4663")) {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" runs on Robinhood Chain mainnet (4663): trades settle in real USDG.` });
    } else if (testnetFlag || (chain && "value" in chain && chain.value.trim() === "46630")) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" runs on the Robinhood Chain testnet (46630), with test funds.` });
    } else {
      out.notes.push({
        level: "warning",
        category: "tools",
        message: `"${t.name}" does not fix the network in its entry, so Hedgehood takes it from ~/.hedgehood/config.json on that computer, or uses the testnet (46630) if there is none. Set HEDGEHOOD_CHAIN_ID=4663 on ${platform} for mainnet.`
      });
    }
    if (isHedgehoodCommand(mcp.command)) {
      out.manualSteps.push(`Install Hedgehood's MCP server for "${t.name}": npm install -g @hedgehood-io/mcp. It needs Node.js 20 or later, and the hedgehood-mcp command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs Hedgehood through npx: ${platform} needs Node.js 20 or later on its PATH.`);
    }
  }
};

/** brainchain-mcp as npx runs it: the bare name, a version or a tag. Anything else (a URL, extra text) is not BrainChain's package. */
const BRAINCHAIN_PKG = /^brainchain-mcp(@(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?))?$/;
/** The brainchain-mcp command from the brainchain-mcp package (also .cmd or .exe on Windows), alone or as a path. */
const isBrainChainCommand = (command: string | undefined) => !!command && /(^|[\\/])brainchain-mcp(\.cmd|\.exe)?$/i.test(command);
const literal = (t: Tool, k: string) => {
  const v = t.mcp?.env[k];
  return v && "value" in v ? v.value.trim() : undefined;
};
/** Base units (6 decimals) as an amount, for example 10000000 as "10". */
const amount = (units: string) => {
  if (!/^\d+$/.test(units)) return units;
  const n = BigInt(units);
  const whole = n / 1000000n;
  const fraction = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};

/**
 * BrainChain, which verifies AI agent work and settles payments on Robinhood Chain and Base, as it
 * documents its MCP server (docs.usebrainchain.com/agents and github.com/usebrainchain/brainchain-mcp,
 * brainchain-mcp 0.9.3, read Nov 15, 2026): `npx -y brainchain-mcp@<version>` or `brainchain-mcp`.
 * It pays from a wallet whose key is in BRAINCHAIN_PAYER_KEY_FILE (~/.brainchain/payer.key) or
 * BRAINCHAIN_PAYER_KEY, never both; it uses mainnet unless BRAINCHAIN_NETWORK=testnet, and pays in USDG
 * on Robinhood Chain unless BRAINCHAIN_PAY_ON=base. Limits are in base units (6 decimals).
 */
const BRAINCHAIN: ServerProfile = {
  id: "brainchain",
  vendor: "BrainChain",
  label: "BrainChain (verified AI work, paid on Robinhood Chain or Base)",
  matches: (t) => !!t.mcp && t.mcp.transport === "stdio" && (isBrainChainCommand(t.mcp.command) || t.mcp.args.some((a) => BRAINCHAIN_PKG.test(a))),
  keyVars: ["BRAINCHAIN_PAYER_KEY_FILE", "BRAINCHAIN_PAYER_KEY"],
  emptyOkEnv: [],
  limitVars: ["BRAINCHAIN_MAX_PRICE_UNITS", "BRAINCHAIN_BUDGET_UNITS", "BRAINCHAIN_DAILY_UNITS", "BRAINCHAIN_MAX_BOND_UNITS", "BRAINCHAIN_STATE_DIR"],
  looserDefaults: {
    BRAINCHAIN_BUDGET_UNITS: "10 per server run",
    BRAINCHAIN_DAILY_UNITS: "no daily cap",
    BRAINCHAIN_MAX_BOND_UNITS: "10 USDG per bond"
  },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    out.notes.push({
      level: "info",
      category: "integrations",
      message: "BrainChain's wallet key and daily spending record stay on this computer in ~/.brainchain. Nomad never reads that folder or any key file, and never moves tasks, bonds or approvals on chain."
    });
    // A raw key is a wallet private key: never written as a value, even with --include-secrets.
    const raw = mcp.env.BRAINCHAIN_PAYER_KEY;
    if (raw && "value" in raw) mcp.env.BRAINCHAIN_PAYER_KEY = { secretRef: "BRAINCHAIN_PAYER_KEY", redacted: true };
    if (mcp.env.BRAINCHAIN_PAYER_KEY && !mcp.env.BRAINCHAIN_PAYER_KEY_FILE) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" was given its wallet key directly. BrainChain recommends BRAINCHAIN_PAYER_KEY_FILE instead: a path to an owner-only file holding only that key, so the key is not in ${platform}'s settings.` });
    }

    const network = mcp.env.BRAINCHAIN_NETWORK;
    const payOn = mcp.env.BRAINCHAIN_PAY_ON;
    const testnet = literal(t, "BRAINCHAIN_NETWORK")?.toLowerCase() === "testnet";
    const base = literal(t, "BRAINCHAIN_PAY_ON")?.toLowerCase() === "base";
    const token = base ? "USDC" : "USDG";
    const perTask = amount(literal(t, "BRAINCHAIN_MAX_PRICE_UNITS") ?? "1000000");
    const perRun = amount(literal(t, "BRAINCHAIN_BUDGET_UNITS") ?? "10000000");
    const where = base ? "Base" : "Robinhood Chain";
    if (network && !("value" in network)) {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" takes its network from BRAINCHAIN_NETWORK, which was a variable on the source. BrainChain uses mainnet (real money) unless it is set to testnet on ${platform}.` });
    } else if (testnet) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" uses the BrainChain testnet and pays in test ${token} on ${base ? "Base Sepolia" : "the Robinhood Chain testnet"}.` });
    } else {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" pays on ${where} mainnet in real ${token}: up to ${perTask} ${token} per task and ${perRun} ${token} per run.` });
    }
    if (payOn && !("value" in payOn)) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" takes where it pays from BRAINCHAIN_PAY_ON, which was a variable on the source: USDG on Robinhood Chain unless it is set to base on ${platform}.` });
    }
    if (!mcp.env.BRAINCHAIN_DAILY_UNITS) {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" has no daily cap on ${platform}: BrainChain then limits only each run, and that budget starts over whenever ${platform} restarts the server. For an agent that runs on its own, set BRAINCHAIN_DAILY_UNITS (in units of 0.000001: 5000000 is 5 ${token}).` });
    }
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `BrainChain: if ${platform} runs on another computer, the wallet key does not come along. Create the key file there yourself (owner-only), for a wallet that holds only what this agent may spend, and set BRAINCHAIN_PAYER_KEY_FILE.`
    });

    // A key that was an optional reference on the source (Hermes) may be left out on the destination.
    // Without it the server still starts, but it cannot pay, so the step says so plainly.
    const optionalEnv = ((mcp as Record<string, unknown>).optionalEnv as string[] | undefined) ?? [];
    const optionalKeys = ["BRAINCHAIN_PAYER_KEY_FILE", "BRAINCHAIN_PAYER_KEY"].filter((k) => mcp.env[k] && optionalEnv.includes(k));
    if (optionalKeys.length) {
      out.manualSteps.push(`"${t.name}" can only pay with its wallet key: make sure ${optionalKeys.join(" or ")} is set for it on ${platform}. Without it the server starts and reads, but cannot post or bond tasks.`);
    }

    // Only BrainChain's own package spec is printed in a command the user runs.
    const pkg = mcp.args.find((a) => BRAINCHAIN_PKG.test(a)) ?? "brainchain-mcp";
    const prefix = `${testnet ? "BRAINCHAIN_NETWORK=testnet " : ""}${base ? "BRAINCHAIN_PAY_ON=base " : ""}BRAINCHAIN_PAYER_KEY_FILE=<key file>`;
    if (!base) out.manualSteps.push(`Paying in USDG needs a one-time approval per wallet. If this wallet has not paid BrainChain in USDG before, run in your own terminal: ${prefix} npx -y ${pkg} approve`);
    out.manualSteps.push(`Check the wallet before the agent pays: ${prefix} npx -y ${pkg} wallet (it prints the wallet and what it still needs, never the key).`);
    if (isBrainChainCommand(mcp.command)) {
      out.manualSteps.push(`Install BrainChain's MCP server for "${t.name}": npm install -g brainchain-mcp. It needs Node.js 22 or later, and the brainchain-mcp command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs BrainChain through npx: ${platform} needs Node.js 22 or later on its PATH.`);
    }
  }
};

/**
 * Skills that only work with the setup they were written for. Nomad moves them like any skill and
 * says so in the preview instead of copying them silently.
 */
export function knownSkillNotes(skills: Array<{ name: string; frontmatter?: Record<string, unknown> }>, platformId: string, platformName: string): Note[] {
  const notes: Note[] = [];
  const fromBrainChain = (s: { frontmatter?: Record<string, unknown> }) => {
    const home = s.frontmatter?.homepage;
    if (typeof home !== "string") return false;
    try {
      return /(^|\.)usebrainchain\.com$/.test(new URL(home).hostname);
    } catch {
      return false;
    }
  };
  for (const s of skills) {
    if (!fromBrainChain(s)) continue;
    if (s.name === "brainchain-worker") {
      notes.push(
        platformId === "openclaw"
          ? { level: "warning", category: "skills", message: `The "brainchain-worker" skill reads its key through OpenClaw's secrets settings, which Nomad does not copy, and the worker itself is a program you run. Redo the skill's "For the operator, first" setup on this OpenClaw, then start the worker again.` }
          : { level: "warning", category: "skills", message: `The "brainchain-worker" skill is written for OpenClaw: it needs the openclaw command, Docker and its key in OpenClaw's secrets settings, so it does not work on ${platformName} as it is. Nomad copies it so nothing is lost.` }
      );
    } else if (s.name === "brainchain" && platformId !== "openclaw") {
      notes.push({ level: "info", category: "skills", message: `The "brainchain" skill is written for OpenClaw: its setup steps use openclaw commands and its wallet check script path is filled in by OpenClaw. The BrainChain MCP tools it describes work the same on ${platformName}.` });
    }
  }
  return notes;
}

const PROFILES: ServerProfile[] = [PRIORS, OAK, HEDGEHOOD, BRAINCHAIN];

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
