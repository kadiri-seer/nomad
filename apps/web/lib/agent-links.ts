/** Public links about Nomad AI, shared by its docs page and the Links tab on /ai. Nothing about minting. */
import { X_HANDLE, X_URL } from "@/components/Social";
import { AGENT_WALLETS, MOVES_URL, addressUrl } from "./agent";

export type AgentLink = { label: string; href: string; note: string; external: boolean };

export const AGENT_LINKS: AgentLink[] = [
  { label: "Live page", href: "/ai", note: "Its wallets, latest moves and running costs, updated live.", external: false },
  { label: "Docs", href: "/docs/nomad-ai", note: "How it runs, its limits and the services it uses.", external: false },
  ...AGENT_WALLETS.map((w) => ({ label: w.name, href: addressUrl(w.address), note: `${w.role}. On the Robinhood Chain explorer.`, external: true })),
  { label: "Rushr profile", href: "https://rushr.trade/nomad_ai", note: "Its trades and standing on Rushr, as nomad_ai.", external: true },
  { label: "Moves feed", href: MOVES_URL, note: "The public lines it writes after each run, as JSON.", external: true },
  { label: `Nomad on X (${X_HANDLE})`, href: X_URL, note: "Updates on Nomad and Nomad AI.", external: true }
];

/** Services Nomad AI uses, with their public sites where known. */
export const AGENT_SERVICES: { name: string; does: string; href?: string }[] = [
  { name: "Oak", does: "Swaps against USDG" },
  { name: "Rushr", does: "Buys and sells against ETH; trader callouts and leaderboard", href: "https://rushr.trade" },
  { name: "Stoa", does: "Market context, token safety checks and quotes", href: "https://stoadex.com" },
  { name: "HEY Research", does: "Chain overview and token markets", href: "https://heyresearch.xyz" },
  { name: "OddsEngine", does: "Token checks, and a check of each trade before it is signed", href: "https://engine.oddsengine.live" },
  { name: "Zolva", does: "What other agents are doing", href: "https://zolvaagent.app" },
  { name: "Memoria", does: "Its memory between runs", href: "https://www.memoriaagent.site" },
  { name: "QHooks", does: "Read-only market data", href: "https://qhooks.com" },
  { name: "Priors", does: "Read-only market data", href: "https://priors.trade" },
  { name: "Hedgehood", does: "Read-only market data", href: "https://hedgehood.io" },
  { name: "BrainChain", does: "Read-only research" },
  { name: "Tokyo Futuro", does: "Read-only market data" }
];
