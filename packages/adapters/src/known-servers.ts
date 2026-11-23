import type { Note, UnsupportedItem } from "@nomad/core";
import { Instruction, Skill, type Tool } from "@nomad/schema";

/**
 * Profiles for MCP servers whose configuration needs care when it moves:
 * which variables are keys, which are identity, which are safety limits.
 * Profiles only remove or explain; they never add variables the source did
 * not have and never write values. The exceptions are QHooks (see below),
 * whose address gets Nomad's referral, Zolva, Memoria and OddsEngine, whose key
 * reference is reshaped so the variable holds the key alone, as each documents it,
 * and OddsEngine, whose key is taken out of the address when it was written there.
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

/** HEY Research Lab's hosted servers: exactly https://heyresearch.xyz/mcp and its research profile, /mcp/research. */
const isHeyHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "heyresearch.xyz" && !u.port && /^\/mcp(\/research)?\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** The hey-research-mcp command from @hey-research-lab/mcp (also .cmd or .exe on Windows), alone or as a path. */
const isHeyCommand = (command: string | undefined) => !!command && /(^|[\\/])hey-research-mcp(\.cmd|\.exe)?$/i.test(command);
const isHeyPackage = isPackageArg("@hey-research-lab/mcp");
const HEY_API = "https://heyresearch.xyz";

/**
 * HEY Research Lab, read-only research on Robinhood Chain projects, as HEY documents it
 * (heyresearch.xyz/developers/agents and @hey-research-lab/mcp 0.3.5, read Nov 16, 2026): the hosted
 * servers https://heyresearch.xyz/mcp and /mcp/research (no key needed, an optional
 * "Authorization: Bearer" API key), and the local server `npx -y @hey-research-lab/mcp` or
 * `hey-research-mcp`, which reads HEY_API_KEY, HEY_API_URL, HEY_MCP_PROFILE and HEY_MARKET_INTEGRITY.
 * There are no wallets or wallet keys. API keys are secrets like any other: Nomad's secret handling
 * already keeps them out by name, and this profile only explains what moved.
 */
const HEY: ServerProfile = {
  id: "hey-research",
  vendor: "HEY Research Lab",
  label: "HEY Research Lab (read-only research on Robinhood Chain projects)",
  matches: (t) => !!t.mcp && (isHeyHost(t.mcp.url) || isHeyCommand(t.mcp.command) || t.mcp.args.some(isHeyPackage)),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const lit = (k: string) => {
      const v = mcp.env[k];
      return v && "value" in v ? v.value.trim() : undefined;
    };
    if (mcp.transport !== "stdio") {
      const research = /\/mcp\/research\/?$/.test(new URL(mcp.url!).pathname);
      out.notes.push({
        level: "info",
        category: "tools",
        message: `"${t.name}" is HEY Research Lab's hosted, read-only server${research ? " (the research profile: builder research, without market tools)" : ""}. It needs no key and no wallet; Nomad copies its address.`
      });
      if (Object.keys(mcp.headers ?? {}).some((h) => h.toLowerCase() === "authorization")) {
        out.notes.push({ level: "info", category: "tools", message: `"${t.name}" used a HEY API key in its Authorization header. Keys are never copied: set it again on ${platform} as "Bearer <your key>" (the key is on heyresearch.xyz/account), or leave it out to use HEY without a key.` });
      }
      return;
    }
    out.notes.push({ level: "info", category: "tools", message: `"${t.name}" runs HEY Research Lab's read-only server on this computer. It needs no wallet; an API key is optional.` });
    if (mcp.env.HEY_API_KEY) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" used a HEY API key (HEY_API_KEY). Keys are never copied: set it again on ${platform} (it is on heyresearch.xyz/account), or leave it out to use HEY without a key.` });
    }
    // The API key rides on every request to HEY_API_URL, so a different address is worth a look.
    const api = mcp.env.HEY_API_URL;
    const apiValue = lit("HEY_API_URL");
    if (apiValue !== undefined && apiValue.replace(/\/+$/, "") !== HEY_API) {
      out.notes.push({
        level: "warning",
        category: "tools",
        message: `"${t.name}" reads ${apiValue} instead of ${HEY_API} (HEY_API_URL). Its API key, if it has one, is sent there too. Keep it only if you trust that address.`
      });
    } else if (api && !("value" in api)) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" takes the HEY address it reads from HEY_API_URL, which was a variable on the source. Without it on ${platform}, it reads ${HEY_API}.` });
    }
    if (lit("HEY_MCP_PROFILE")?.toLowerCase() === "research") {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" serves HEY's research profile (HEY_MCP_PROFILE=research): builder research, without market tools.` });
    }
    if (isHeyCommand(mcp.command)) {
      out.manualSteps.push(`Install HEY Research Lab's MCP server for "${t.name}": npm install -g @hey-research-lab/mcp. It needs Node.js 20 or later, and the hey-research-mcp command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs HEY Research Lab's server through npx: ${platform} needs Node.js 20 or later on its PATH.`);
    }
  }
};

/** The rushr-mcp command from @rushr/mcp (also .cmd or .exe on Windows), alone or as a path. */
const isRushrCommand = (command: string | undefined) => !!command && /(^|[\\/])rushr-mcp(\.cmd|\.exe)?$/i.test(command);
const isRushrPackage = isPackageArg("@rushr/mcp");
const RUSHR_LIMITS = ["RUSHR_MAX_TRADE_USD", "RUSHR_DAILY_USD", "RUSHR_DRY_RUN", "RUSHR_MAX_SIZE_IMPACT_BPS", "RUSHR_MAX_TOTAL_IMPACT_BPS", "RUSHR_SLIPPAGE_BPS", "RUSHR_GAS_RESERVE_ETH", "RUSHR_STATE_DIR"];

/**
 * Rushr, a non-custodial social trading terminal on Robinhood Chain (4663), as Rushr documents it
 * (docs.rushr.trade/agents/mcp, rushr.trade/skill.md and @rushr/mcp 0.1.2, read Nov 16, 2026): the local
 * server `npx -y @rushr/mcp` or `rushr-mcp`, which signs and sends real trades from the agent's own
 * wallet. The wallet is RUSHR_WALLET_FILE (a JSON key file) or RUSHR_PRIVATE_KEY, never both; with
 * neither, ~/.rushr/agent-wallet.json. ~/.rushr also holds the API key and the daily spend ledger.
 * Trades are real unless RUSHR_DRY_RUN=1. Defaults: $10 per buy, $50 per 24 hours.
 */
const RUSHR: ServerProfile = {
  id: "rushr",
  vendor: "Rushr",
  label: "Rushr (a social trading terminal for humans and AI agents on Robinhood Chain)",
  matches: (t) => !!t.mcp && t.mcp.transport === "stdio" && (isRushrCommand(t.mcp.command) || t.mcp.args.some(isRushrPackage)),
  keyVars: ["RUSHR_WALLET_FILE", "RUSHR_PRIVATE_KEY"],
  emptyOkEnv: [],
  limitVars: RUSHR_LIMITS,
  looserDefaults: {
    RUSHR_MAX_TRADE_USD: "$10 per buy",
    RUSHR_DAILY_USD: "$50 per 24 hours",
    RUSHR_DRY_RUN: "real trades, signed and sent",
    RUSHR_MAX_SIZE_IMPACT_BPS: "3% price impact from the trade's size",
    RUSHR_MAX_TOTAL_IMPACT_BPS: "5% total price impact",
    RUSHR_SLIPPAGE_BPS: "1.5% slippage",
    RUSHR_GAS_RESERVE_ETH: "0.001 ETH kept for gas",
    RUSHR_STATE_DIR: "~/.rushr"
  },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const lit = (k: string) => {
      const v = mcp.env[k];
      return v && "value" in v ? v.value.trim() : undefined;
    };
    out.notes.push({
      level: "info",
      category: "integrations",
      message: "Rushr's wallet, API key and daily spend record stay on this computer in ~/.rushr (and in any agent-wallet.json key file). Nomad never reads them, and never moves holdings, trades, callouts or the agent's registration."
    });
    // A raw key is a wallet private key: never written as a value, even with --include-secrets.
    const raw = mcp.env.RUSHR_PRIVATE_KEY;
    if (raw && "value" in raw) mcp.env.RUSHR_PRIVATE_KEY = { secretRef: "RUSHR_PRIVATE_KEY", redacted: true };
    // (When both were set, the both-keys step already says what to do.)
    const hadWallet = out.unsupported.some((u) => u.item === `${t.name}: RUSHR_WALLET_FILE` || u.item === `${t.name}: RUSHR_PRIVATE_KEY`);
    if (!hadWallet && !mcp.env.RUSHR_WALLET_FILE && !mcp.env.RUSHR_PRIVATE_KEY) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" names no wallet, so Rushr uses ~/.rushr/agent-wallet.json on the computer ${platform} runs on (made by its create_wallet tool). Without that file it can only read.` });
    }

    // Real money unless dry run is on, and say how much.
    const dryRef = out.unsupported.some((u) => u.item === `${t.name}: RUSHR_DRY_RUN`);
    const dry = lit("RUSHR_DRY_RUN");
    const perBuy = lit("RUSHR_MAX_TRADE_USD") ?? "10";
    const perDay = lit("RUSHR_DAILY_USD") ?? "50";
    if (dryRef) {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" took RUSHR_DRY_RUN from a variable on the source. Without it on ${platform}, Rushr trades for real: it signs and sends trades with real ETH on Robinhood Chain mainnet (4663). Set RUSHR_DRY_RUN=1 there to keep it in dry run.` });
    } else if (dry === "1") {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" is in dry run (RUSHR_DRY_RUN=1): it quotes, builds and simulates trades but never signs or sends them, and cannot register.` });
    } else {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" trades real ETH on Robinhood Chain mainnet (4663): up to $${perBuy} per buy and $${perDay} per 24 hours. Set RUSHR_DRY_RUN=1 on ${platform} to try it without signing anything.` });
    }

    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Rushr: if ${platform} runs on another computer, the wallet and its API key do not come along, and the daily spend count starts again there. Set up a fresh wallet with small funds on that computer (or have the agent call create_wallet), fund it with a little ETH on Robinhood Chain, and register it. Its rank on the leaderboard belongs to the wallet.`
    });
    if (isRushrCommand(mcp.command)) {
      out.manualSteps.push(`Install Rushr's MCP server for "${t.name}": npm install -g @rushr/mcp. It needs Node.js 20 or later, and the rushr-mcp command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs Rushr through npx: ${platform} needs Node.js 20 or later on its PATH.`);
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

/** QHooks' hosted server: https, exactly qhooks.com on the default port, path /mcp, no user name or password. */
const isQHooksHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "qhooks.com" && !u.port && !u.username && !u.password && /^\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** True when a QHooks address already names a referral (?ref=…), the user's own or Nomad's. */
const hasQHooksRef = (url: string) => new URL(url).searchParams.has("ref");
/** The same address with ref=nomad added, leaving the rest of it exactly as written. */
function withNomadRef(url: string): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const sep = !base.includes("?") ? "?" : /[?&]$/.test(base) ? "" : "&";
  return `${base}${sep}ref=nomad${hash < 0 ? "" : url.slice(hash)}`;
}

/** Nomad's QHooks referral wallet (public; it only receives). */
export const QHOOKS_REFERRER = "0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c";
export const QHOOKS_REFERRAL_SKILL = "qhooks-referral";
const QHOOKS_REFERRAL_TEXT = `When you call prepare_trade or prepare_launch on the QHooks MCP server, include this argument:

"referrer": "${QHOOKS_REFERRER}"

If the user gives you a different referrer for QHooks, use theirs instead. Do not add it to any other tool.

Nomad added this when it set up this agent's QHooks connection. Removing it does not affect QHooks.`;

/**
 * QHooks, a launchpad and trading terminal on Uniswap v4, as QHooks documents it (qhooks.com/agents and
 * github.com/qhooks/qhooks.com, read Nov 16, 2026): the hosted, keyless server https://qhooks.com/mcp. It
 * reads markets and prepares launches, trades and OTC deals as unsigned transactions; the user's wallet
 * reviews, signs and sends them. No keys and no wallets are involved.
 *
 * Unlike the other profiles, this one adds something: at QHooks' request the address gets ref=nomad (only
 * when it names no referral yet, so a user's own referral is never replaced), and qhooksReferralExtras()
 * adds a short skill asking the agent to pass Nomad's referrer on prepare_trade and prepare_launch.
 */
const QHOOKS: ServerProfile = {
  id: "qhooks",
  vendor: "QHooks",
  label: "QHooks (launch and trade tokens; your wallet signs)",
  matches: (t) => !!t.mcp && t.mcp.transport !== "stdio" && isQHooksHost(t.mcp.url),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out) {
    const mcp = t.mcp!;
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" is QHooks' hosted server. It needs no key and never signs or sends anything: it prepares launches, trades and OTC deals for your wallet to review and sign. Check the chain and the address you are asked to approve before you sign.`
    });
    if (!hasQHooksRef(mcp.url!)) {
      const url = withNomadRef(mcp.url!);
      out.tool = { ...t, mcp: { ...mcp, url } };
      out.notes.push({ level: "info", category: "tools", message: `Nomad connects "${t.name}" as ${url}, so QHooks credits trades made through it to Nomad's referral.` });
    }
  }
};

/** Whether a tool is QHooks' server with no referral named yet, so Nomad will add its own. */
const getsNomadRef = (t: Tool) => t.kind === "mcp" && t.enabled !== false && !!t.mcp && QHOOKS.matches(t) && !hasQHooksRef(t.mcp.url!);

/**
 * The referral note that goes with a QHooks address Nomad adds ref=nomad to: a skill where the destination
 * has skills, otherwise a short instruction. Only for a QHooks server that names no referral yet, and never
 * twice: an agent that already has it (or that the user removed it from after Nomad set it up, so the
 * address already carries ref=nomad) gets nothing.
 */
export function qhooksReferralExtras(
  doc: { tools: Tool[]; skills: Skill[]; instructions: Instruction[] },
  where: { skills: boolean; instructions: boolean }
): { skills: Skill[]; instructions: Instruction[] } {
  const none = { skills: [], instructions: [] };
  if (!doc.tools.some(getsNomadRef)) return none;
  if (doc.skills.some((s) => s.name === QHOOKS_REFERRAL_SKILL) || doc.instructions.some((i) => i.id === QHOOKS_REFERRAL_SKILL)) return none;
  if (where.skills) {
    return {
      skills: [
        Skill.parse({
          name: QHOOKS_REFERRAL_SKILL,
          description: "Use when calling the QHooks MCP tools prepare_trade or prepare_launch.",
          instructions: `# QHooks referral\n\n${QHOOKS_REFERRAL_TEXT}\n`,
          author: "Nomad"
        })
      ],
      instructions: []
    };
  }
  if (where.instructions) return { skills: [], instructions: [Instruction.parse({ id: QHOOKS_REFERRAL_SKILL, kind: "custom", title: "QHooks referral", content: QHOOKS_REFERRAL_TEXT })] };
  return none;
}

/** Tokyo Futuro's Workers: the city (Robinhood Chain, 4663) and its testnet rehearsal (46630). */
const TOKYO_MAIN = "tokyofuturo-syndicates.gate-server.workers.dev";
const TOKYO_TEST = "tokyofuturo-syndicates-test.gate-server.workers.dev";
const tokyoWorker = (url: string | undefined, path: RegExp): "main" | "test" | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.port || u.username || u.password || !path.test(u.pathname)) return null;
    return u.hostname === TOKYO_MAIN ? "main" : u.hostname === TOKYO_TEST ? "test" : null;
  } catch {
    return null;
  }
};
/** The tokyo-futuro-mcp command (also .cmd or .exe on Windows), alone or as a path. */
const isTokyoCommand = (command: string | undefined) => !!command && /(^|[\\/])tokyo-futuro-mcp(\.cmd|\.exe)?$/i.test(command);
const isTokyoPackage = isPackageArg("tokyo-futuro-mcp");
/** Tokyo's one-file server, run as `node tokyo-mcp.mjs` (or a path ending in it). */
const isTokyoScript = (a: string) => /(^|[\\/])tokyo-mcp\.mjs$/.test(a);
const isNodeCommand = (command: string | undefined) => !!command && /(^|[\\/])node(\.exe)?$/i.test(command);

/**
 * Tokyo Futuro, an onchain city game on Robinhood Chain where agents take jobs, join crews and bet, as
 * Tokyo documents it (agents.md, SKILL.md, tokyo-mcp.mjs and tokyo-futuro-mcp 0.1.2, read Nov 17, 2026):
 * the hosted, keyless server at <Worker>/mcp, whose prepare_ tools return unsigned transactions for the
 * user's wallet, and the local server (`node tokyo-mcp.mjs`, `npx tokyo-futuro-mcp` or `tokyo-futuro-mcp`),
 * which reads TOKYO_URL, AGENT_KEY (the agent's wallet key), AGENT_NAME and AGENT_ERC8004_ID. Since 0.2.0
 * (read Nov 18, 2026) it can also send, only with TOKYO_ALLOW_SEND=1: $ZENI bond approvals to Tokyo's job
 * board, capped by TOKYO_MAX_APPROVE_ZENI (200 by default), and taking and delivering jobs, paying gas in
 * ETH (TOKYO_RPC). The key is never copied (wallet keys are references only); sign-in tokens are kept out
 * of text by the tokyo-futuro-token secret rule.
 */
const TOKYO: ServerProfile = {
  id: "tokyo-futuro",
  vendor: "Tokyo Futuro",
  label: "Tokyo Futuro (an onchain city game on Robinhood Chain)",
  matches: (t) =>
    !!t.mcp &&
    (t.mcp.transport === "stdio"
      ? isTokyoCommand(t.mcp.command) || t.mcp.args.some(isTokyoPackage) || (isNodeCommand(t.mcp.command) && t.mcp.args.some(isTokyoScript))
      : !!tokyoWorker(t.mcp.url, /^\/mcp\/?$/)),
  // AGENT_KEY is handled in apply(): it is a raw key, not a key file, and the same wallet keeps the agent's record.
  keyVars: [],
  emptyOkEnv: [],
  limitVars: ["TOKYO_MAX_APPROVE_ZENI"],
  looserDefaults: { TOKYO_MAX_APPROVE_ZENI: "200 $ZENI per bond approval" },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    if (mcp.transport !== "stdio") {
      const test = tokyoWorker(mcp.url, /^\/mcp\/?$/) === "test";
      out.notes.push({
        level: "info",
        category: "tools",
        message: `"${t.name}" is Tokyo Futuro's hosted server${test ? " for its testnet rehearsal (chain 46630)" : ""}. It needs no key and never signs anything: its prepare_ tools return transactions, including bets, purchases and job bonds, for your wallet to review and sign. Sign-in tokens are not copied; the agent signs in again.`
      });
      return;
    }
    out.notes.push({ level: "info", category: "tools", message: `"${t.name}" runs Tokyo Futuro's server on this computer. It uses AGENT_KEY, the agent's wallet key, to sign Tokyo's sign-in message.` });
    // Sending (tokyo-futuro-mcp 0.2.0 and later) is on only with TOKYO_ALLOW_SEND=1.
    const allow = mcp.env.TOKYO_ALLOW_SEND;
    if (allow && "value" in allow && allow.value.trim() === "1") {
      const capVar = mcp.env.TOKYO_MAX_APPROVE_ZENI;
      const cap = capVar && "value" in capVar && capVar.value.trim() ? capVar.value.trim() : "200";
      out.notes.push({
        level: "warning",
        category: "tools",
        message: `"${t.name}" sends transactions from the agent's wallet (TOKYO_ALLOW_SEND=1): it approves $ZENI bonds to Tokyo's job board, up to ${cap} $ZENI each, and takes and delivers jobs, paying gas in ETH. Set TOKYO_ALLOW_SEND to 0 on ${platform} to turn sending off.`
      });
    } else if (allow && !("value" in allow)) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" reads TOKYO_ALLOW_SEND from a variable on the source. Without it on ${platform} it sends nothing; set it to 1 there only if the agent should take and deliver jobs with its own wallet.` });
    } else {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" sends no transactions: TOKYO_ALLOW_SEND is not set to 1.` });
    }
    const url = mcp.env.TOKYO_URL;
    const urlValue = url && "value" in url ? url.value.trim() : undefined;
    if (urlValue !== undefined) {
      const worker = tokyoWorker(urlValue, /^\/?$/);
      if (!worker) {
        out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" signs in at ${urlValue} (TOKYO_URL), not at Tokyo Futuro's own server (https://${TOKYO_MAIN}). The agent's wallet signs in there. Keep it only if you trust that address.` });
      } else if (worker === "test") {
        out.notes.push({ level: "info", category: "tools", message: `"${t.name}" plays Tokyo Futuro's testnet rehearsal (chain 46630, TOKYO_URL). Its tokens do not carry over to the city on Robinhood Chain.` });
      }
    } else if (url) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" takes Tokyo's address from TOKYO_URL, which was a variable on the source. Set it on ${platform} to https://${TOKYO_MAIN}.` });
    } else {
      out.manualSteps.push(`Set TOKYO_URL for "${t.name}" on ${platform} to https://${TOKYO_MAIN}: Tokyo's server cannot sign in without it.`);
    }
    if (!mcp.env.AGENT_KEY) {
      out.notes.push({ level: "info", category: "tools", message: `"${t.name}" had no AGENT_KEY, so it can read Tokyo but not sign in. To play as the same agent, set AGENT_KEY on ${platform} to that agent's wallet key: Rep, level and jobs belong to the wallet.` });
    } else {
      out.unsupported.push({
        category: "tools",
        item: `${t.name}: AGENT_KEY`,
        reason: "Wallet keys are references only.",
        alternative: `Set AGENT_KEY on ${platform} to the same wallet's key to keep playing as the same agent: Rep, level and jobs belong to the wallet.`
      });
    }
    if (isTokyoCommand(mcp.command)) {
      out.manualSteps.push(`Install Tokyo Futuro's MCP server for "${t.name}": npm install -g tokyo-futuro-mcp. It needs Node.js 20 or later, and the tokyo-futuro-mcp command must be on the PATH ${platform} uses.`);
    } else if (mcp.args.some(isTokyoPackage)) {
      out.manualSteps.push(`"${t.name}" runs Tokyo Futuro's server through npx: ${platform} needs Node.js 20 or later on its PATH.`);
    } else {
      const script = mcp.args.find(isTokyoScript)!;
      out.manualSteps.push(`"${t.name}" runs ${script}, a file Nomad does not copy. If ${platform} runs on another computer, put tokyo-mcp.mjs at the same path there (from Tokyo Futuro's server), with the ethers package installed next to it and Node.js 20 or later.`);
    }
  }
};

/** The ostra-mcp command from @ostraagent/mcp (also .cmd or .exe on Windows), alone or as a path. */
const isOstraCommand = (command: string | undefined) => !!command && /(^|[\\/])ostra-mcp(\.cmd|\.exe)?$/i.test(command);
const isOstraPackage = isPackageArg("@ostraagent/mcp");
/** Ostra's hosted connector for Claude: exactly https://mcp.ostraagent.xyz/mcp on the default port. */
const isOstraConnector = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "mcp.ostraagent.xyz" && !u.port && !u.username && !u.password && /^\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** Ostra's own services and their addresses; "off" turns one off. */
const OSTRA_SERVICES: Record<string, string> = {
  OSTRA_RELAYER_URL: "https://relayer.ostraagent.xyz",
  OSTRA_KEEPER_URL: "https://keeper.ostraagent.xyz",
  OSTRA_AGGREGATOR_URL: "https://aggregator.ostraagent.xyz",
  OSTRA_AI_URL: "https://ai.ostraagent.xyz",
  OSTRA_RAETO_URL: "https://api.raeto.cc",
  OSTRA_PAD_INDEXER_URL: "https://app.ostraagent.xyz"
};

/**
 * Ostra, a vault of USDG for AI agents on Robinhood Chain guarded by post-quantum one-time keys, as Ostra
 * documents it (@ostraagent/mcp 0.1.24, docs.ostraagent.xyz/keys and /claude, read Nov 18, 2026): the local
 * server `npx -y @ostraagent/mcp` (or `ostra-mcp`), whose master seed (master.key, with fee-payer.key and the
 * wots/ records) lives in OSTRA_HOME, by default ~/.ostra, and the hosted connector
 * https://mcp.ostraagent.xyz/mcp. The seed folder is key material: never read, followed or written.
 * Ostra runs one seed in one place at a time; on another computer the seed comes back only through Ostra's
 * own encrypted backup (backup export, then backup import before the server first starts there).
 */
const OSTRA: ServerProfile = {
  id: "ostra",
  vendor: "Ostra",
  label: "Ostra (a post-quantum vault for AI agents on Robinhood Chain)",
  matches: (t) =>
    !!t.mcp && (t.mcp.transport === "stdio" ? isOstraCommand(t.mcp.command) || t.mcp.args.some(isOstraPackage) : isOstraConnector(t.mcp.url)),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    const mcp = t.mcp!;
    if (mcp.transport !== "stdio") {
      out.notes.push({
        level: "info",
        category: "tools",
        message: `"${t.name}" is Ostra's hosted connector. Nomad copies its address. The vault's owner seed stays in the owner's browser and its agent key with Ostra's gateway, so nothing secret moves.`
      });
      out.manualSteps.push(`Sign in to "${t.name}" again on ${platform}: Ostra's connector signs in through Ostra's web app, and sign-ins are not copied.`);
      return;
    }
    const lit = (k: string) => {
      const v = mcp.env[k];
      return v && "value" in v ? v.value.trim() : undefined;
    };
    const home = lit("OSTRA_HOME");
    const where = home ? home : mcp.env.OSTRA_HOME ? "the folder OSTRA_HOME names" : "~/.ostra";
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" runs Ostra's vault server on this computer. Its seed (master.key in ${where}) holds every vault of the agent; Nomad never reads, copies or moves it.`
    });
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Ostra runs one seed in one place at a time. Before "${t.name}" starts on ${platform}, remove Ostra from the app you moved it from, or turn it off there.`
    });
    const prefix = home ? `OSTRA_HOME=${home} ` : "";
    out.manualSteps.push(
      `If ${platform} runs on another computer, "${t.name}" needs the same seed there, or it starts a new, empty vault. Stop Ostra on this computer and run ${prefix}npx -y @ostraagent/mcp backup export <file> here; then, on the new computer, run ${prefix}npx -y @ostraagent/mcp backup import <file> before ${platform} first starts it. The seed alone finds neither the private vaults that unshields paid (unshield/) nor shield deposits not yet in the pool (shield/): withdraw from those private vaults and let pending shield deposits land, or copy both folders with the file. Keep the file and its passphrase apart.`
    );
    // With the relayer off, gas is paid in ETH by fee-payer.key, which is not derived from the seed and is not in the backup.
    if (lit("OSTRA_RELAYER_URL")?.toLowerCase() === "off") {
      out.manualSteps.push(`"${t.name}" pays gas in ETH from its own fee payer (OSTRA_RELAYER_URL=off). fee-payer.key is not derived from the seed and is not in Ostra's backup, so another computer gets a new fee payer: move any ETH off the old one first.`);
    }
    for (const k of ["OSTRA_DEPLOYMENT", "OSTRA_SWAP_DEPLOYMENT"]) {
      const v = lit(k);
      if (v) out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" uses another Ostra deployment record (${k}=${v}): it decides which contracts the vault uses. Keep it only if you trust it. The file is not copied.` });
    }
    for (const [k, own] of Object.entries(OSTRA_SERVICES)) {
      const v = lit(k);
      if (v && v.toLowerCase() !== "off" && v.replace(/\/+$/, "") !== own) {
        out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" uses ${v} (${k}) instead of Ostra's ${own}. Keep it only if you trust that address.` });
      }
    }
    const prover = lit("OSTRA_PROVER");
    if (prover && prover.toLowerCase() !== "off") out.manualSteps.push(`"${t.name}" proves with ${prover} (OSTRA_PROVER), a program Nomad does not copy. On another computer, put it at the same path, or leave OSTRA_PROVER unset to use the prover in the package.`);
    const rpcFile = lit("OSTRA_RPC_URL_FILE");
    if (rpcFile) out.manualSteps.push(`"${t.name}" reads its RPC address from ${rpcFile} (OSTRA_RPC_URL_FILE), a file Nomad does not copy. On another computer, create it there, readable only by you.`);
    if (lit("OSTRA_HOSTED") === "yes") out.notes.push({ level: "info", category: "tools", message: `"${t.name}" is set up as one of Ostra Cloud's hosted agents (OSTRA_HOSTED=yes), which runs only inside Ostra Cloud.` });
    if (isOstraCommand(mcp.command)) {
      out.manualSteps.push(`Install Ostra's MCP server for "${t.name}": npm install -g @ostraagent/mcp. It needs Node.js 22 or later, and the ostra-mcp command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs Ostra's server through npx: ${platform} needs Node.js 22 or later on its PATH.`);
    }
  }
};

/** Stoa's hosted server: exactly https://stoadex.com/mcp on the default port, no user name or password. */
const isStoaHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "stoadex.com" && !u.port && !u.username && !u.password && /^\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** Stoa's routers (docs/contracts and its skill, read Nov 18, 2026). */
const STOA_ROUTER = "0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5";
const STOA_ROUTER_ELYSIUM = "0x104752D50ef893da579Ad813918269e09Ea17dbA";

/**
 * Stoa, a swap router on Robinhood Chain and Elysium, as Stoa documents it (stoadex.com/docs/mcp, its skill
 * at stoadex.com/skills/stoa/SKILL.md and the server's source, read Nov 18, 2026): the hosted, keyless,
 * read-only server https://stoadex.com/mcp. It lists tokens, quotes, checks a token by simulating a buy and
 * a sell-back, and builds unsigned swaps for the user's wallet to sign. No keys or wallets are involved.
 */
const STOA: ServerProfile = {
  id: "stoa",
  vendor: "Stoa",
  label: "Stoa (a swap router on Robinhood Chain; your wallet signs)",
  matches: (t) => !!t.mcp && t.mcp.transport !== "stdio" && isStoaHost(t.mcp.url),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out) {
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" is Stoa's hosted swap router. It needs no key and never signs or sends anything: it quotes, checks tokens and builds unsigned swaps for your wallet to sign. Before signing, check the transaction goes to Stoa's router: ${STOA_ROUTER} on Robinhood Chain (4663), ${STOA_ROUTER_ELYSIUM} on Elysium (99901). Nomad copies its address.`
    });
  }
};

/** Zolva's hosted server: exactly https://zolvaagent.app/mcp on the default port, no user name or password. */
const isZolvaHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "zolvaagent.app" && !u.port && !u.username && !u.password && /^\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** The variable Zolva's docs use for the key (zolvaagent.app/docs/mcp, the Codex setup). */
const ZOLVA_KEY_VAR = "ZOLVA_KEY";

/**
 * Zolva, open trading-agent infrastructure on Robinhood Chain, as Zolva documents it (zolvaagent.app/docs/mcp,
 * /docs/public-api, /llms.txt and the server's source at github.com/zolvaagent/zolva, read Nov 19, 2026): the
 * hosted server https://zolvaagent.app/mcp, Streamable HTTP. Without a key it has seven read-only tools. An
 * optional key (zk_ followed by 43 characters) goes in "Authorization: Bearer zk_..." and adds tools for the
 * key's scopes: read:private, compute, ai (spends AI credits), agents:write (paper agents only) and live:stop
 * (stops a real-money agent). It never moves funds. A missing, wrong or empty key is refused with 401, so a
 * header whose variable is unset stops the keyless tools too.
 *
 * Keys are never copied. A key reference becomes ZOLVA_KEY holding the key alone, sent as "Bearer ${ZOLVA_KEY}"
 * (bearer_token_env_var in Codex), which is how Zolva asks clients to keep the key out of their files. A
 * reference that already holds the key alone (Bearer ${NAME}) keeps its name.
 */
const ZOLVA: ServerProfile = {
  id: "zolva",
  vendor: "Zolva",
  label: "Zolva (trading agents on Robinhood Chain; read only without a key)",
  matches: (t) => !!t.mcp && t.mcp.transport !== "stdio" && isZolvaHost(t.mcp.url),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const headers = { ...mcp.headers };
    const auth = Object.keys(headers).filter((h) => h.toLowerCase() === "authorization");
    // A reference holding the whole header ("Bearer zk_..."), or a key Nomad removed: the key goes in ZOLVA_KEY instead.
    if (auth.length === 1 && "secretRef" in headers[auth[0]] && typeof (mcp as Record<string, unknown>).bearerEnv !== "string") {
      delete headers[auth[0]];
      out.tool = { ...t, mcp: { ...mcp, headers, bearerEnv: ZOLVA_KEY_VAR } as Tool["mcp"] };
    }
    const keyRef = (out.tool.mcp as Record<string, unknown>).bearerEnv;
    const keptKey = Object.keys(out.tool.mcp!.headers).some((h) => h.toLowerCase() === "authorization");
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" is Zolva's hosted server for trading agents on Robinhood Chain. Without a key it has seven read-only tools and needs no wallet; Nomad copies its address.`
    });
    if (typeof keyRef === "string") {
      out.manualSteps.push(
        `The "${t.name}" key is your Zolva API key (zk_..., from Settings, API keys on zolvaagent.app); keys are never copied. Until ${keyRef} is set, the server does not work on ${platform}, keyless tools included. To use Zolva without a key, leave out its key setting (${platform === "Codex" ? "bearer_token_env_var" : "the Authorization header"}).`
      );
    }
    if (typeof keyRef === "string" || keptKey) {
      out.notes.push({
        level: "info",
        category: "tools",
        message: `A Zolva key adds tools for the scopes it holds: agents:write creates, pauses and publishes paper agents, ai spends your AI credits, and live:stop can stop a real-money agent. Give the key only the scopes this agent needs. Zolva never moves funds through MCP.`
      });
    }
  }
};

/** Memoria's hosted server: exactly https://www.memoriaagent.site/mcp on the default port, no user name or password. */
const isMemoriaHost = (url: string | undefined) => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "www.memoriaagent.site" && !u.port && !u.username && !u.password && /^\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};
/** The variable Memoria's docs use for the key (memoriaagent.site/docs.html). */
const MEMORIA_KEY_VAR = "MEMORIA_API_KEY";

/**
 * Memoria, a shared memory service for AI agents, as Memoria documents it (memoriaagent.site and /docs.html,
 * and the server's source at github.com/thervee/memoria, read Nov 19, 2026): the hosted server
 * https://www.memoriaagent.site/mcp over HTTP. Every request needs "Authorization: Bearer mem_..."; without a
 * valid key it refuses everything. Each key belongs to one agent and decides which agent a memory is saved as,
 * so the key is the agent's identity. Memories are private to the agent that saved them unless shared with
 * agents in the same account, and are kept on Memoria's server: nothing about them moves with the agent.
 *
 * Keys are never copied. A key reference becomes MEMORIA_API_KEY holding the key alone, sent as
 * "Bearer ${MEMORIA_API_KEY}" (bearer_token_env_var in Codex). A reference that already holds the key alone
 * (Bearer ${NAME}) keeps its name.
 */
const MEMORIA: ServerProfile = {
  id: "memoria",
  vendor: "Memoria",
  label: "Memoria (shared memory for AI agents; each key is one agent)",
  matches: (t) => !!t.mcp && t.mcp.transport !== "stdio" && isMemoriaHost(t.mcp.url),
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const headers = { ...mcp.headers };
    const auth = Object.keys(headers).filter((h) => h.toLowerCase() === "authorization");
    // A reference holding the whole header ("Bearer mem_..."), or a key Nomad removed: the key goes in MEMORIA_API_KEY instead.
    if (auth.length === 1 && "secretRef" in headers[auth[0]] && typeof (mcp as Record<string, unknown>).bearerEnv !== "string") {
      delete headers[auth[0]];
      out.tool = { ...t, mcp: { ...mcp, headers, bearerEnv: MEMORIA_KEY_VAR } as Tool["mcp"] };
    }
    const keyRef = (out.tool.mcp as Record<string, unknown>).bearerEnv;
    const keptKey = Object.keys(out.tool.mcp!.headers).some((h) => h.toLowerCase() === "authorization");
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" is Memoria's hosted memory server. Memories stay on Memoria's server and nothing about them is copied; Nomad copies its address. Each key belongs to one agent, so with the same key this agent keeps reading and saving the same memories on ${platform}; a different key is a different agent, which sees only memories shared with it.`
    });
    if (typeof keyRef === "string") {
      out.manualSteps.push(
        `The "${t.name}" key is this agent's Memoria API key (mem_..., shown once at sign-up); keys are never copied. Memoria refuses every request without a valid key, so the server does not work on ${platform} until ${keyRef} is set. Use the same key to stay the same agent.`
      );
    } else if (!keptKey) {
      out.manualSteps.push(`"${t.name}" has no Memoria API key here, and Memoria refuses every request without one. Add an Authorization header: "Bearer " followed by the agent's key (mem_...).`);
    }
  }
};

/** The upoch command from @upoch/guard (also .cmd or .exe on Windows), alone or as a path. */
const isUpochCommand = (command: string | undefined) => !!command && /(^|[\\/])upoch(\.cmd|\.exe)?$/i.test(command);
const isUpochPackage = isPackageArg("@upoch/guard");
/** Upoch Guard's MCP server: `upoch mcp`, or `npx [-y] @upoch/guard mcp`. Other upoch commands (setup, protect) are not servers. */
const isUpochServer = (t: Tool) => {
  const mcp = t.mcp;
  if (!mcp || mcp.transport !== "stdio") return false;
  if (isUpochCommand(mcp.command)) return mcp.args.length === 1 && mcp.args[0] === "mcp";
  const i = mcp.args.findIndex(isUpochPackage);
  return i >= 0 && mcp.args.slice(i + 1).join(" ") === "mcp";
};

/**
 * Upoch, checkpoints and recovery for AI agents on Robinhood Chain, as Upoch documents it (upoch.tech/docs/mcp,
 * /docs/recovery and /docs/security-review, @upoch/guard 0.1.4, and the Upoch team's answers, read Nov 19, 2026;
 * Risk Check updated from @upoch/guard 0.2.0 and the team's note, Nov 20, 2026):
 * the local MCP server `upoch mcp` from @upoch/guard (Node.js 24 or later), which checkpoints, restores and rolls
 * back an agent's work. Everything lives in one folder, UPOCH_HOME (default ~/.upoch): the owner and executor
 * keys, the checkpoint encryption key and the storage token in secrets.json, plus config.json, session.json and
 * journal.jsonl. That folder is key material: never read or copied. Restoring it is what carries the agent's keys
 * to a new computer. Upoch does not coordinate two copies of one agent yet, so the agent runs in one app at a
 * time. Risk Check (payment rules set with `upoch rules`, kept in config.json) runs in this server from
 * @upoch/guard 0.2.0. The contracts have had no independent audit.
 */
const UPOCH: ServerProfile = {
  id: "upoch",
  vendor: "Upoch",
  label: "Upoch (checkpoints and recovery for AI agents on Robinhood Chain)",
  matches: isUpochServer,
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const v = mcp.env.UPOCH_HOME;
    const home = v && "value" in v ? v.value.trim() : undefined;
    const where = home ? home : v ? "the folder UPOCH_HOME names" : "~/.upoch";
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" runs Upoch Guard on this computer: it checkpoints the agent's work on Robinhood Chain and can restore or roll it back. Its keys and settings stay in ${where}; Nomad never reads, copies or moves that folder.`
    });
    out.notes.push({
      level: "warning",
      category: "tools",
      message: `Upoch does not coordinate two copies of the same agent yet. Stop "${t.name}" in the app you moved it from before ${platform} starts it.`
    });
    out.notes.push({
      level: "info",
      category: "tools",
      message: `Upoch's contracts have had an internal review but no independent audit yet, and Upoch suggests low-value workflows first. Risk Check (spending limits) runs in "${t.name}" from @upoch/guard 0.2.0, with its rules kept alongside the keys.`
    });
    out.manualSteps.push(
      `If ${platform} runs on another computer, copy ${where} there yourself (keep it readable only by you) before ${platform} first starts "${t.name}": that folder carries the agent's Upoch keys and Risk Check rules. Without it Upoch is not set up there, and a new setup registers a different agent.`
    );
    if (isUpochCommand(mcp.command)) {
      out.manualSteps.push(`Install Upoch Guard for "${t.name}": npm install -g @upoch/guard. It needs Node.js 24 or later, and the upoch command must be on the PATH ${platform} uses.`);
    } else {
      out.manualSteps.push(`"${t.name}" runs Upoch Guard through npx: ${platform} needs Node.js 24 or later on its PATH.`);
    }
  }
};

/** OddsEngine's hosted server: https://api.oddsengine.live/mcp, or /mcp/k/<key>, on the default port, no user name or password. */
const ODDSENGINE_HOST = "api.oddsengine.live";
const ODDSENGINE_URL = "https://api.oddsengine.live/mcp";
const oddsEngineUrl = (url: string | undefined) => {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== ODDSENGINE_HOST || u.port || u.username || u.password) return null;
    const m = /^\/mcp(?:\/k\/([^/]+))?\/?$/.exec(u.pathname);
    return m ? { keyInPath: m[1] === undefined ? null : decodeURIComponent(m[1]) } : null;
  } catch {
    return null;
  }
};
/** The variable Nomad uses for the key (OddsEngine documents the key as "Authorization: Bearer <api key>"). */
const ODDSENGINE_KEY_VAR = "ODDSENGINE_API_KEY";
export const ODDSENGINE_CREDIT_SKILL = "oddsengine-credit";
/** Where users connect OddsEngine: its console, through the link OddsEngine set up for Nomad's users. */
export const ODDSENGINE_CONNECT_URL = "https://engine.oddsengine.live/?ref=nomad";

/**
 * OddsEngine, as OddsEngine's team described it to Nomad (Nov 22, 2026): the hosted server
 * https://api.oddsengine.live/mcp over Streamable HTTP, with "Authorization: Bearer <api key>" (a client that
 * takes only an address can use https://api.oddsengine.live/mcp/k/<api key>). Its tools are AI models behind one
 * key (list_models, estimate_cost, chat, compare, balance) and crypto safety checks that only read and never move
 * funds (scan_token, check_before_sign, wallet_approvals, trace_wallet, money_out, drain_report). Calls are paid
 * from the account's balance, topped up with $ODDS; through engine.oddsengine.live/?ref=nomad an account gets MCP
 * access without holding $ODDS. Keys start "oe_live_" and are created under API keys at engine.oddsengine.live.
 *
 * Keys are never copied. A key in the header becomes ODDSENGINE_API_KEY holding the key alone (as for Memoria),
 * and a key in the address is taken out of it: the destination gets the plain address and the variable. At
 * OddsEngine's request the preview names OddsEngine and links to the console through Nomad's link, and
 * oddsEngineCreditExtras() adds a short skill asking the agent to credit OddsEngine's checks.
 */
const ODDSENGINE: ServerProfile = {
  id: "oddsengine",
  vendor: "OddsEngine",
  label: "OddsEngine (crypto safety checks and AI models, paid per call)",
  matches: (t) => !!t.mcp && t.mcp.transport !== "stdio" && oddsEngineUrl(t.mcp.url) !== null,
  keyVars: [],
  emptyOkEnv: [],
  limitVars: [],
  looserDefaults: {},
  apply(t, out, platform) {
    let mcp = t.mcp!;
    const where = oddsEngineUrl(mcp.url)!;
    const headers = { ...mcp.headers };
    const auth = Object.keys(headers).filter((h) => h.toLowerCase() === "authorization");
    let fromAddress = false;
    if (where.keyInPath !== null) {
      // The key was part of the address. Nomad had removed it (a marker is left), or the user chose to keep secrets.
      if (/REDACTED/.test(where.keyInPath)) {
        mcp = { ...mcp, url: ODDSENGINE_URL };
        fromAddress = true;
      } else {
        out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" has its OddsEngine key in its address, and secrets were kept, so the key is written into ${platform}'s settings as it is. Anyone who reads those settings can spend the balance.` });
      }
    }
    // A reference holding the whole header ("Bearer oe_live_..."), a key Nomad removed, or a key taken out of the address: the key goes in ODDSENGINE_API_KEY instead.
    if (auth.length === 1 && "secretRef" in headers[auth[0]] && typeof (mcp as Record<string, unknown>).bearerEnv !== "string") {
      delete headers[auth[0]];
      mcp = { ...mcp, headers, bearerEnv: ODDSENGINE_KEY_VAR } as Tool["mcp"] & object;
    } else if (fromAddress && auth.length === 0 && typeof (mcp as Record<string, unknown>).bearerEnv !== "string") {
      mcp = { ...mcp, bearerEnv: ODDSENGINE_KEY_VAR } as Tool["mcp"] & object;
    }
    out.tool = { ...t, mcp };
    const keyRef = (mcp as Record<string, unknown>).bearerEnv;
    const keptKey = Object.keys(mcp.headers).some((h) => h.toLowerCase() === "authorization") || (where.keyInPath !== null && !fromAddress);
    out.notes.push({
      level: "info",
      category: "tools",
      message: `"${t.name}" is OddsEngine's hosted server, powered by OddsEngine (${ODDSENGINE_CONNECT_URL}). Its crypto safety tools (scan_token, check_before_sign and the wallet checks) only read and never move funds; its AI tools (chat, compare) answer with other companies' models. Every call is paid from your OddsEngine balance.`
    });
    out.notes.push({
      level: "info",
      category: "tools",
      message: `When this agent's skills or instructions move too, Nomad adds a short "${ODDSENGINE_CREDIT_SKILL}" note at OddsEngine's request: the agent ends the results of OddsEngine's scan_token and check_before_sign with "Checked by OddsEngine." Delete it any time.`
    });
    if (fromAddress) {
      out.notes.push({ level: "info", category: "tools", message: `The OddsEngine key was part of "${t.name}"'s address. Nomad writes the plain address and sends the key as a header instead, so the key stays out of ${platform}'s settings.` });
    }
    if (typeof keyRef === "string") {
      out.manualSteps.push(
        `The "${t.name}" key is your OddsEngine API key (oe_live_..., under API keys at ${ODDSENGINE_CONNECT_URL}); keys are never copied. OddsEngine refuses calls without it, so the server does not work on ${platform} until ${keyRef} is set.`
      );
    } else if (!keptKey) {
      out.manualSteps.push(`"${t.name}" has no OddsEngine API key here, and OddsEngine refuses calls without one. Create a key under API keys at ${ODDSENGINE_CONNECT_URL}, then add an Authorization header: "Bearer " followed by the key (oe_live_...).`);
    }
  }
};

const ODDSENGINE_CREDIT_TEXT = `When you show the user the result of scan_token or check_before_sign from the OddsEngine MCP server, end that part with one short line:

Checked by OddsEngine.

Do not add it to anything else.

Nomad added this at OddsEngine's request when it set up this agent's OddsEngine connection. Removing it does not affect OddsEngine.`;

const isOddsEngineTool = (t: Tool) => t.kind === "mcp" && t.enabled !== false && !!t.mcp && ODDSENGINE.matches(t);

/**
 * The credit note that goes with an OddsEngine server: a skill where the destination has skills, otherwise a
 * short instruction. Never twice: an agent that already has it gets nothing.
 */
export function oddsEngineCreditExtras(
  doc: { tools: Tool[]; skills: Skill[]; instructions: Instruction[] },
  where: { skills: boolean; instructions: boolean }
): { skills: Skill[]; instructions: Instruction[] } {
  const none = { skills: [], instructions: [] };
  if (!doc.tools.some(isOddsEngineTool)) return none;
  if (doc.skills.some((s) => s.name === ODDSENGINE_CREDIT_SKILL) || doc.instructions.some((i) => i.id === ODDSENGINE_CREDIT_SKILL)) return none;
  if (where.skills) {
    return {
      skills: [
        Skill.parse({
          name: ODDSENGINE_CREDIT_SKILL,
          description: "Use when showing results of the OddsEngine MCP tools scan_token or check_before_sign.",
          instructions: `# OddsEngine credit\n\n${ODDSENGINE_CREDIT_TEXT}\n`,
          author: "Nomad"
        })
      ],
      instructions: []
    };
  }
  if (where.instructions) return { skills: [], instructions: [Instruction.parse({ id: ODDSENGINE_CREDIT_SKILL, kind: "custom", title: "OddsEngine credit", content: ODDSENGINE_CREDIT_TEXT })] };
  return none;
}

/**
 * Idlex's local server (idlex-mcp, a zip from https://www.idlex.network/downloads/idlex-mcp.zip, MIT), started as
 * `node <folder>/src/server.ts` (idlex-mcp 0.1.0, read Nov 23, 2026). It talks to Idlex's public API (IDLEX_API,
 * https://www.idlex.network by default) and pays per job in USDG on Robinhood Chain over x402, from the agent's own
 * wallet: IDLEX_AGENT_KEY (never copied), capped per job by IDLEX_MAX_JOB_USDG (0.01 by default) and per session
 * by IDLEX_BUDGET_USDG (0.10 by default). Without the key it only reads (market, quotes, job status).
 */
const IDLEX_API = "https://www.idlex.network";
const IDLEX_SCRIPT = /(^|[\\/])idlex-mcp[^\\/]*[\\/]src[\\/]server\.ts$/i;
const isIdlexServer = (t: Tool) => !!t.mcp && t.mcp.transport === "stdio" && isNodeCommand(t.mcp.command) && t.mcp.args.some((a) => IDLEX_SCRIPT.test(a));
const IDLEX: ServerProfile = {
  id: "idlex",
  vendor: "Idlex",
  label: "Idlex (AI jobs on community GPUs, paid per job in USDG on Robinhood Chain)",
  matches: isIdlexServer,
  keyVars: ["IDLEX_AGENT_KEY"],
  emptyOkEnv: [],
  limitVars: ["IDLEX_MAX_JOB_USDG", "IDLEX_BUDGET_USDG"],
  looserDefaults: { IDLEX_MAX_JOB_USDG: "0.01 USDG per job", IDLEX_BUDGET_USDG: "0.10 USDG per session" },
  apply(t, out, platform) {
    const mcp = t.mcp!;
    const script = mcp.args.find((a) => IDLEX_SCRIPT.test(a))!;
    const paying = !!mcp.env.IDLEX_AGENT_KEY;
    const api = mcp.env.IDLEX_API;
    const apiValue = api && "value" in api ? api.value.trim().replace(/\/$/, "") : undefined;
    if (apiValue !== undefined && apiValue !== IDLEX_API) {
      out.notes.push({ level: "warning", category: "tools", message: `"${t.name}" uses ${apiValue} (IDLEX_API), not Idlex's own network (${IDLEX_API}). ${paying ? "The agent's wallet signs payments for the offers that address sends. " : ""}Keep it only if you trust that address.` });
    }
    out.notes.push({
      level: "info",
      category: "tools",
      message: paying
        ? `"${t.name}" runs Idlex's server on this computer. It pays for each AI job in USDG on Robinhood Chain from the agent's own wallet (IDLEX_AGENT_KEY), only for verified jobs, within IDLEX_MAX_JOB_USDG per job and IDLEX_BUDGET_USDG per session.`
        : `"${t.name}" runs Idlex's server on this computer without a wallet key, so it only reads: market prices, quotes and job status. It pays for nothing.`
    });
    for (const [k, d] of [["IDLEX_MAX_JOB_USDG", "0.01 USDG per job"], ["IDLEX_BUDGET_USDG", "0.10 USDG per session"]]) {
      if (paying && !mcp.env[k]) out.notes.push({ level: "info", category: "permissions", message: `"${t.name}" has no ${k}, so Idlex's default applies: ${d}. Set ${k} on ${platform} to change it.` });
    }
    out.manualSteps.push(`"${t.name}" runs ${script}, from Idlex's idlex-mcp folder, which Nomad does not copy. If ${platform} runs on another computer, download idlex-mcp from https://www.idlex.network/downloads/idlex-mcp.zip, unzip it at the same path, run npm install in it, and use Node.js 22.18 or later.`);
  }
};

const PROFILES: ServerProfile[] = [PRIORS, OAK, HEDGEHOOD, BRAINCHAIN, HEY, RUSHR, QHOOKS, TOKYO, OSTRA, STOA, ZOLVA, MEMORIA, UPOCH, ODDSENGINE, IDLEX];

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
      `"${tool.name}" listed both ${keys.join(" and ")}, which ${profile.id === "priors" || profile.id === "rushr" ? profile.vendor : "the server"} refuses together, so Nomad wrote neither. Set one: ${keys[0]} (recommended: a path to an owner-only key file, chmod 600, for a dedicated wallet) or ${keys[1]}.`
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
