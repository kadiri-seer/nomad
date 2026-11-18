import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { appFromClientName, applyConnect, connectStatus, editEntry, NOMAD_SKILL, nomadLaunch, planConnect, planDisconnect, serverEntry } from "@nomad/migration";
import { setup, treeHash, type Env } from "../helpers";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

const launch = { command: "/opt/nomad/bin/nomad", args: [] as string[] };
const read = (p: string) => readFileSync(join(env.home, p), "utf8");
/** Every app file in the fake home (the Nomad store itself is left out). */
const appsHash = () => [".openclaw", ".claude", ".codex", ".hermes"].map((d) => treeHash(join(env.home, d))).join(",") + read(".claude.json");

describe("nomad connect", () => {
  it("previews without writing, then adds Nomad to each app found and keeps everything else", async () => {
    const before = appsHash();
    const toml = read(".codex/config.toml");
    const yaml = read(".hermes/config.yaml");
    const claude = JSON.parse(read(".claude.json"));
    const p = await planConnect(env.nomad, { launch, platform: "linux" });
    expect(appsHash()).toBe(before);
    const apps = Object.fromEntries(p.targets.map((t) => [t.app, t]));
    expect(Object.keys(apps).sort()).toEqual(["claude-code", "codex", "hermes", "openclaw"]);
    expect(apps["claude-code"].server).toBe("add");
    expect(apps["claude-code"].skill).toBe("add");
    expect(apps.codex.server).toBe("add");
    expect(apps.hermes.server).toBe("add");
    // openclaw.json has comments: OpenClaw's own command does it, so they are kept.
    expect(apps.openclaw.server).toBe("manual");
    expect(apps.openclaw.manual).toBe(`openclaw mcp set nomad '{"command":"/opt/nomad/bin/nomad","args":["mcp","--app","openclaw"]}'`);

    const r = await applyConnect(env.nomad, p.id);
    expect(r.targets.every((t) => t.ok)).toBe(true);
    expect(r.backupId).toBeTruthy();

    // Claude Code: the server is added; every other setting and server is unchanged.
    const c = JSON.parse(read(".claude.json"));
    expect(c.mcpServers.nomad).toEqual({ type: "stdio", command: launch.command, args: ["mcp", "--app", "claude-code"], env: {} });
    delete c.mcpServers.nomad;
    expect(c).toEqual(claude);
    expect(read(".claude/skills/nomad/SKILL.md")).toBe(NOMAD_SKILL);

    // Codex: the TOML is the same text with one table appended, comments included.
    const t = read(".codex/config.toml");
    expect(t.startsWith(toml)).toBe(true);
    expect((parseToml(t) as any).mcp_servers.nomad).toEqual({ command: launch.command, args: ["mcp", "--app", "codex"] });
    expect((parseToml(t) as any).mcp_servers.docs).toEqual({ command: "npx", args: ["-y", "docs-mcp"] });

    // Hermes: comments and the other servers stay.
    const y = read(".hermes/config.yaml");
    expect(y).toContain("# Hermes configuration");
    expect(parseYaml(y).mcp_servers.nomad).toEqual({ command: launch.command, args: ["mcp", "--app", "hermes"] });
    expect(parseYaml(y).mcp_servers.filesystem).toEqual(parseYaml(yaml).mcp_servers.filesystem);

    // OpenClaw: its file is untouched; the skill is written.
    expect(read(".openclaw/openclaw.json")).toContain("// OpenClaw configuration");
    expect(JSON5.parse(read(".openclaw/openclaw.json")).mcp).toBeUndefined();
    expect(existsSync(join(env.home, ".openclaw/skills/nomad/SKILL.md"))).toBe(true);
    expect(r.targets.find((x) => x.app === "openclaw")!.manual).toContain("openclaw mcp set nomad");

    const status = Object.fromEntries((await connectStatus({ platform: "linux" })).map((s) => [s.app, s]));
    expect(status["claude-code"].connected).toBe(true);
    expect(status["claude-code"].writes).toBe(false);
    expect(status.openclaw.connected).toBe(false);
    expect(status.cursor.detected).toBe(false);
    expect(env.nomad.history()[0].kind).toBe("connect");

    // Connecting again changes nothing.
    const again = await planConnect(env.nomad, { launch, platform: "linux" });
    expect(again.changes).toBe(0);
    expect(again.targets.filter((x) => x.app !== "openclaw").every((x) => x.server === "unchanged")).toBe(true);
  });

  it("updates the entry for --allow-writes, then takes Nomad out again, leaving the files as they were", async () => {
    const toml = read(".codex/config.toml");
    const yaml = read(".hermes/config.yaml");
    const claude = JSON.parse(read(".claude.json"));
    await applyConnect(env.nomad, (await planConnect(env.nomad, { launch, platform: "linux" })).id);
    const w = await planConnect(env.nomad, { launch, platform: "linux", allowWrites: true });
    expect(w.targets.find((t) => t.app === "codex")!.server).toBe("update");
    await applyConnect(env.nomad, w.id);
    expect((parseToml(read(".codex/config.toml")) as any).mcp_servers.nomad.args).toEqual(["mcp", "--app", "codex", "--allow-writes"]);
    expect((await connectStatus({ platform: "linux" })).find((s) => s.app === "codex")!.writes).toBe(true);

    const off = await planDisconnect(env.nomad, { platform: "linux" });
    const offApps = Object.fromEntries(off.targets.map((t) => [t.app, t]));
    expect(offApps.codex.server).toBe("remove");
    expect(offApps["claude-code"].skill).toBe("remove");
    expect(offApps.openclaw.server).toBe("absent");
    const r = await applyConnect(env.nomad, off.id);
    expect(r.targets.every((t) => t.ok)).toBe(true);
    expect(read(".codex/config.toml")).toBe(toml);
    expect(read(".hermes/config.yaml")).toBe(yaml);
    expect(JSON.parse(read(".claude.json"))).toEqual(claude);
    expect(existsSync(join(env.home, ".claude/skills/nomad"))).toBe(false);
    expect(existsSync(join(env.home, ".claude/skills/pdf-tools/SKILL.md"))).toBe(true);
    expect(env.nomad.history()[0].kind).toBe("disconnect");
  });

  it("never replaces a nomad skill it did not write, and keeps an edited one on removal", async () => {
    const mine = join(env.home, ".codex/skills/nomad/SKILL.md");
    mkdirSync(join(mine, ".."), { recursive: true });
    writeFileSync(mine, "---\nname: nomad\ndescription: Someone else's skill.\n---\n");
    const p = await planConnect(env.nomad, { launch, platform: "linux", apps: ["codex", "claude-code"] });
    expect(p.targets.find((t) => t.app === "codex")!.skill).toBe("kept");
    await applyConnect(env.nomad, p.id);
    expect(readFileSync(mine, "utf8")).toContain("Someone else's skill.");

    writeFileSync(join(env.home, ".claude/skills/nomad/SKILL.md"), NOMAD_SKILL + "\nMy own note.\n");
    const off = await planDisconnect(env.nomad, { platform: "linux", apps: ["codex", "claude-code"] });
    expect(off.targets.find((t) => t.app === "claude-code")!.skill).toBe("kept");
    await applyConnect(env.nomad, off.id);
    expect(readFileSync(join(env.home, ".claude/skills/nomad/SKILL.md"), "utf8")).toContain("My own note.");
    expect(readFileSync(mine, "utf8")).toContain("Someone else's skill.");
  });

  it("connects a named app that was not found, and can be undone with the backup", async () => {
    const p = await planConnect(env.nomad, { launch, platform: "linux", apps: ["cursor"] });
    expect(p.targets).toHaveLength(1);
    expect(p.targets[0].detected).toBe(false);
    const r = await applyConnect(env.nomad, p.id);
    expect(JSON.parse(read(".cursor/mcp.json"))).toEqual({ mcpServers: { nomad: { command: launch.command, args: ["mcp", "--app", "cursor"] } } });
    await env.nomad.restore(r.backupId!);
    expect(existsSync(join(env.home, ".cursor/mcp.json"))).toBe(false);
    await expect(planConnect(env.nomad, { launch, apps: ["notepad"] })).rejects.toThrow(/Unknown app: notepad/);
  });

  it("gives Gemini CLI's own command when its settings have comments", async () => {
    mkdirSync(join(env.home, ".gemini"), { recursive: true });
    const settings = '{\n  // mine\n  "theme": "Default"\n}\n';
    writeFileSync(join(env.home, ".gemini/settings.json"), settings);
    const p = await planConnect(env.nomad, { launch, platform: "linux", apps: ["gemini-cli"] });
    expect(p.targets[0].server).toBe("manual");
    expect(p.targets[0].manual).toBe("gemini mcp add -s user nomad /opt/nomad/bin/nomad mcp --app gemini-cli");
    await applyConnect(env.nomad, p.id);
    expect(read(".gemini/settings.json")).toBe(settings);
    writeFileSync(join(env.home, ".gemini/settings.json"), '{\n  // mine\n  "mcpServers": { "nomad": { "command": "x", "args": [] } }\n}\n');
    expect((await connectStatus({ platform: "linux" })).find((s) => s.app === "gemini-cli")!.connected).toBe(true);
    expect((await planDisconnect(env.nomad, { platform: "linux", apps: ["gemini-cli"] })).targets[0].manual).toBe("gemini mcp remove -s user nomad");
  });

  it("refuses files it cannot edit safely and changes nothing in them", async () => {
    writeFileSync(join(env.home, ".claude.json"), "{ not json");
    const t = join(env.home, ".codex/config.toml");
    writeFileSync(t, 'mcp_servers = { nomad = { command = "old" } }\n');
    const p = await planConnect(env.nomad, { launch, platform: "linux", apps: ["claude-code", "codex", "hermes"] });
    expect(p.targets.find((x) => x.app === "claude-code")!.server).toBe("blocked");
    expect(p.targets.find((x) => x.app === "codex")!.error).toMatch(/inline table/);
    const r = await applyConnect(env.nomad, p.id);
    expect(read(".claude.json")).toBe("{ not json");
    expect(readFileSync(t, "utf8")).toBe('mcp_servers = { nomad = { command = "old" } }\n');
    expect(r.targets.find((x) => x.app === "hermes")!.ok).toBe(true);
  });
});

describe("connect helpers", () => {
  it("edits one entry in each format and nothing else", () => {
    const e = { command: "nomad", args: ["mcp"] };
    expect(editEntry("yaml", "mcp_servers:\nother: 1\n", ["mcp_servers", "nomad"], e)).toContain("nomad:");
    expect(parseYaml(editEntry("yaml", "", ["mcp_servers", "nomad"], e))).toEqual({ mcp_servers: { nomad: e } });
    expect(JSON.parse(editEntry("json", "", ["mcpServers", "nomad"], e))).toEqual({ mcpServers: { nomad: e } });
    const flow = editEntry("yaml", "# keep me\nmcp_servers: { x: { command: y } }\n", ["mcp_servers", "nomad"], e);
    expect(parseYaml(flow)).toEqual({ mcp_servers: { x: { command: "y" }, nomad: e } });
    expect(flow).toContain("# keep me");
    const nested = "mcp_servers:\n    x:\n        command: y\nz: 1 # note\n";
    const added = editEntry("yaml", nested, ["mcp_servers", "nomad"], e);
    expect(parseYaml(added)).toEqual({ mcp_servers: { x: { command: "y" }, nomad: e }, z: 1 });
    expect(editEntry("yaml", added, ["mcp_servers", "nomad"], null)).toBe(nested);
    const toml = 'a = 1\n\n[mcp_servers.nomad]\ncommand = "x"\n\n[mcp_servers.nomad.env]\nK = "v"\n\n[b]\nc = 2\n';
    expect(editEntry("toml", toml, ["mcp_servers", "nomad"], null)).toBe('a = 1\n\n[b]\nc = 2\n');
    expect(() => editEntry("json", '{"mcpServers": []}', ["mcpServers", "nomad"], e)).toThrow(/not a table/);
    expect(editEntry("json", '{"a":1}', ["mcpServers", "nomad"], null)).toBe('{"a":1}');
  });

  it("starts the installed launcher, this script, or npx", () => {
    expect(nomadLaunch({ installRoot: "/opt/nomad", platform: "linux" })).toEqual({ command: join("/opt/nomad", "bin", "nomad"), args: [] });
    expect(nomadLaunch({ installRoot: "C:\\Nomad", platform: "win32" })).toEqual({ command: "cmd", args: ["/c", join("C:\\Nomad", "bin", "nomad.cmd")] });
    expect(nomadLaunch({ platform: "linux", script: "/x/dist/nomad.js", execPath: "/usr/bin/node" })).toEqual({ command: "/usr/bin/node", args: ["/x/dist/nomad.js"] });
    expect(nomadLaunch({ platform: "linux", script: "/repo/apps/cli/src/index.ts" }).command).toBe("npx");
    expect(serverEntry("codex", launch, { allowWrites: true, home: "/h" }).args).toEqual(["--home", "/h", "mcp", "--app", "codex", "--allow-writes"]);
  });

  it("knows apps by the name their client gives", () => {
    expect(appFromClientName("claude-code")).toBe("claude-code");
    expect(appFromClientName("codex-mcp-client")).toBe("codex");
    expect(appFromClientName("claude-ai")).toBe("claude-desktop");
    expect(appFromClientName("gemini-cli-mcp-client")).toBe("gemini-cli");
    expect(appFromClientName("cursor-vscode")).toBe("cursor");
    expect(appFromClientName("something-else")).toBeNull();
    expect(appFromClientName(undefined)).toBeNull();
  });
});
