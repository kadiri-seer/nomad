import { describe, expect, it } from "vitest";
import { createDocument } from "@nomad/core";
import { isMnemonic, isPublicRpcUrl, sanitizeDocument, scanDocument, scanMcpLaunchFields, scanText } from "@nomad/security";

const KEY = "0x" + "4f3c2a1b9d8e7f60".repeat(4);
const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const ids = (text: string) => scanText(text, "t").map((f) => f.ruleId);

describe("wallet key rules", () => {
  it("finds wallet keys, recovery phrases and key assignments", () => {
    expect(ids(`cast send --private-key ${KEY} 0xabc`)).toContain("evm-private-key");
    expect(ids(`PRIVATE_KEY=${KEY}`).length).toBeGreaterThan(0);
    expect(ids(`signer: ${KEY}`)).toContain("evm-private-key");
    expect(ids(`MNEMONIC="${MNEMONIC}"`)).toContain("bip39-mnemonic");
    expect(ids(MNEMONIC)).toContain("bip39-mnemonic");
    expect(isMnemonic(MNEMONIC)).toBe(true);
  });

  it("leaves hashes, addresses, ids, hosts and public RPCs alone", () => {
    expect(ids(`The transaction 0x${"ab12".repeat(16)} was confirmed in block 7.`)).toEqual([]);
    expect(ids("Agent wallet address 0x9b1c4e7a03d5f2861c0e9a47b3d8f152a6c04e7d")).toEqual([]);
    expect(ids("PRIORS_AGENT_ID=7311")).toEqual([]);
    expect(ids("PRIORS_PAY_HOSTS=api.example.com")).toEqual([]);
    expect(ids("abandon ability able about above absent absorb abstract absurd abuse access")).toEqual([]); // 11 words
    expect(ids("We should go to the market and then come back home before the evening rain starts")).toEqual([]);
    for (const h of ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com", "https://rpc.ordofi.network"]) expect(isPublicRpcUrl(h)).toBe(true);
    expect(isPublicRpcUrl("https://eth-mainnet.g.alchemy.com/v2/abc123secret")).toBe(false);
    expect(isPublicRpcUrl("https://rpc.mainnet.chain.robinhood.com/?key=1")).toBe(false);
  });

  it("checks MCP launch fields without context", () => {
    expect(scanMcpLaunchFields("w", { args: ["--x", KEY] }).map((f) => f.ruleId)).toContain("evm-private-key");
    expect(scanMcpLaunchFields("w", { url: `https://rpc.example/${KEY}` }).length).toBe(1);
  });

  it("turns key files, wallet values and private RPC URLs into references", () => {
    const d = createDocument({ name: "A", platform: "claude-code" });
    d.tools.push({
      name: "priors-wallet",
      kind: "mcp",
      enabled: true,
      permissions: [],
      platforms: [],
      mcp: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@priors/mcp@0.20.0", KEY],
        env: {
          PRIORS_KEY_FILE: { value: "/home/a/.config/priors/agent.key" },
          PRIORS_AGENT_ID: { value: "7311" },
          PRIORS_PAY_HOSTS: { value: "api.example.com" },
          PRIORS_RPC: { value: "https://eth.provider.example/v2/secretpath" },
          RPC_URL: { value: "https://rpc.mainnet.chain.robinhood.com" },
          SIGNER: { value: KEY }
        },
        headers: {}
      }
    });
    const scan = scanDocument(d);
    expect(scan.findings.some((f) => f.ruleId === "evm-private-key")).toBe(true);
    const { doc, report } = sanitizeDocument(d);
    const env = doc.tools[0].mcp!.env;
    expect(env.PRIORS_KEY_FILE).toEqual({ secretRef: "PRIORS_KEY_FILE", redacted: true });
    expect(env.PRIORS_RPC).toEqual({ secretRef: "PRIORS_RPC", redacted: true });
    expect(env.SIGNER).toEqual({ secretRef: "SIGNER", redacted: true });
    expect(env.PRIORS_AGENT_ID).toEqual({ value: "7311" });
    expect(env.PRIORS_PAY_HOSTS).toEqual({ value: "api.example.com" });
    expect(env.RPC_URL).toEqual({ value: "https://rpc.mainnet.chain.robinhood.com" });
    expect(JSON.stringify(doc)).not.toContain(KEY);
    expect(report.strippedEnvValues.map((s) => s.key).sort()).toEqual(["PRIORS_KEY_FILE", "PRIORS_RPC", "SIGNER"]);
  });
});
