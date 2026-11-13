import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentDocument, Integration } from "@nomad/schema";
import { createDocument, NomadError, type Adapter, type AgentRef, type DesiredFile, type Note, type PlannedWrite, type VerifyCheck } from "@nomad/core";
import { listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import { isSensitiveEnvKey, looksLikeSecretValue } from "@nomad/security";
import { ELIZAOS_INFO } from "./catalog";
import { elizaosPluginHint, knownElizaosPlugin } from "./elizaos-known-plugins";
import { knownServerId } from "./known-servers";
import { mcpServersFromTools, safeName, toolsFromMcpServers, wants } from "./util";

/**
 * ElizaOS characters, JSON only. TypeScript characters are reported and never
 * imported or run. `secrets` and `settings.secrets` are deleted right after
 * parsing: only their names are kept, so values never reach the document,
 * notes or errors.
 */

const P = "elizaos";
const X = "x-elizaos";
const MAX_BYTES = 1024 * 1024;
const MAX_EXAMPLES_BYTES = 256 * 1024;
const PRIORS_OWNER = "PRIORS_OWNER_ENTITY_IDS";
const KNOWN_KEYS = new Set(["name", "username", "id", "bio", "system", "style", "adjectives", "topics", "messageExamples", "postExamples", "templates", "knowledge", "plugins", "settings", "secrets", "modelProvider", "nomadAgentId"]);
const STYLE_KEYS = ["all", "chat", "post"] as const;
const PROVIDERS: Record<string, string> = { anthropic: "anthropic", openai: "openai", openrouter: "openrouter", google: "google", groq: "groq", ollama: "ollama" };

type Json = Record<string, unknown>;

async function isFile(p: string) {
  try {
    return (await fsp.lstat(p)).isFile();
  } catch {
    return false;
  }
}

/** Character files under a project folder, or the file itself when the root is a .json file. */
async function characterFiles(root: string): Promise<Array<{ id: string; path: string }>> {
  if (/\.json$/i.test(root) && (await isFile(root))) return [{ id: basename(root).replace(/(\.character)?\.json$/i, ""), path: root }];
  const out: Array<{ id: string; path: string }> = [];
  for (const dir of [join(root, "characters"), root]) {
    for (const e of await listDir(dir)) {
      if (!(e.file || e.symlink)) continue;
      const isChar = dir === root ? /\.character\.json$/i.test(e.name) : /\.json$/i.test(e.name);
      if (!isChar) continue;
      const id = e.name.replace(/(\.character)?\.json$/i, "");
      if (!out.some((o) => o.id === id)) out.push({ id, path: join(dir, e.name) });
    }
  }
  return out;
}

async function typescriptCharacters(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of ["character.ts", "src/character.ts", "src/characters"]) {
    if (!(await pathExists(join(root, rel)))) continue;
    if (rel.endsWith(".ts")) found.push(rel);
    else for (const e of await listDir(join(root, rel))) if (e.file && e.name.endsWith(".ts")) found.push(`${rel}/${e.name}`);
  }
  return found;
}

function isSecretEntry(key: string, value: unknown): boolean {
  if (isSensitiveEnvKey(key)) return true;
  return typeof value === "string" && looksLikeSecretValue(value);
}

/** Remove secret-looking entries from an object (one level), keeping their names. */
function stripSecrets(obj: Json, names: string[], prefix = ""): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretEntry(k, v)) {
      names.push(prefix + k);
      continue;
    }
    out[k] = v;
  }
  return out;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null));

/** Parse a character and delete its secrets before anything else touches it. */
export function parseCharacter(text: string): { character: Json; secretNames: string[] } {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A character file must hold a JSON object.");
  const character = parsed as Json;
  const secretNames: string[] = [];
  if (character.secrets && typeof character.secrets === "object") secretNames.push(...Object.keys(character.secrets as Json));
  delete character.secrets;
  const settings = character.settings && typeof character.settings === "object" && !Array.isArray(character.settings) ? (character.settings as Json) : undefined;
  if (settings?.secrets && typeof settings.secrets === "object") secretNames.push(...Object.keys(settings.secrets as Json));
  if (settings) delete settings.secrets;
  return { character, secretNames };
}

/** ElizaOS character -> Nomad document. */
export function characterToDocument(character: Json, secretNames: string[], path: string, notes: Note[]): AgentDocument {
  const name = typeof character.name === "string" && character.name.trim() ? character.name.trim() : basename(path).replace(/(\.character)?\.json$/i, "");
  const doc = createDocument({ name, platform: P });
  if (typeof character.nomadAgentId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(character.nomadAgentId)) doc.id = character.nomadAgentId;
  const settings = (character.settings && typeof character.settings === "object" ? character.settings : {}) as Json;
  if (typeof settings.nomadAgentId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(settings.nomadAgentId)) doc.id = settings.nomadAgentId;
  const x: Json = {};
  const src = (field: string) => ({ platform: P, path: `${basename(path)}#${field}` });

  if (typeof character.username === "string") x.username = character.username;
  if (typeof character.id === "string") x.characterId = character.id;

  if (Array.isArray(character.bio)) {
    doc.identity.persona = character.bio.map(String).join("\n");
    x.bioShape = "array";
  } else if (typeof character.bio === "string") {
    doc.identity.persona = character.bio;
    x.bioShape = "string";
  } else notes.push({ level: "info", category: "identity", message: "The character has no bio." });

  if (typeof character.system === "string" && character.system.trim()) doc.instructions.push({ id: "eliza-system", kind: "system", title: "System", content: character.system, source: src("system") });

  if (character.style && typeof character.style === "object") {
    x.style = character.style;
    const style = character.style as Record<string, unknown>;
    for (const k of STYLE_KEYS) {
      const items = Array.isArray(style[k]) ? (style[k] as unknown[]).map(String) : [];
      if (items.length) doc.instructions.push({ id: `eliza-style-${k}`, kind: "conventions", title: `Style (${k})`, content: items.map((i) => `- ${i}`).join("\n"), source: src(`style.${k}`) });
    }
  }
  if (Array.isArray(character.adjectives)) {
    x.adjectives = character.adjectives;
    const tone = character.adjectives.map(String).join(", ");
    doc.identity.tone = tone.length > 200 ? `${tone.slice(0, 197).replace(/,[^,]*$/, "")}...` : tone;
  }
  if (Array.isArray(character.topics)) x.topics = character.topics;
  for (const k of ["messageExamples", "postExamples"] as const) {
    if (character[k] === undefined) continue;
    if (bytes(x.messageExamples) + bytes(character[k]) > MAX_EXAMPLES_BYTES) {
      notes.push({ level: "warning", category: "identity", message: `${k} is larger than 256 KB and was left out.` });
      continue;
    }
    x[k] = character[k];
  }
  if (character.templates && typeof character.templates === "object") {
    x.templates = Object.fromEntries(Object.entries(character.templates as Json).filter(([, v]) => typeof v === "string"));
  }

  if (Array.isArray(character.knowledge)) {
    let n = 0;
    for (const k of character.knowledge) {
      if (typeof k === "string") doc.memory.push({ id: `eliza-knowledge-${++n}`, kind: "fact", scope: "agent", content: k, tags: [], source: src("knowledge") });
      else if (k && typeof k === "object") {
        const ref = k as Json;
        const p = typeof ref.path === "string" ? ref.path : typeof ref.directory === "string" ? ref.directory : null;
        if (p) doc.knowledge.push({ path: p, ...(typeof ref.directory === "string" ? { directory: true } : {}), ...(typeof ref.shared === "boolean" ? { shared: ref.shared } : {}) });
      }
    }
  }

  if (Array.isArray(character.plugins)) {
    for (const raw of character.plugins) {
      if (typeof raw !== "string") continue;
      const known = knownElizaosPlugin(raw);
      const local = raw.startsWith(".") || raw.startsWith("/");
      const it: Integration = {
        name: raw,
        kind: "elizaos-plugin",
        requiresAuth: !!known?.sensitive.length,
        config: known ? { requiredSettingNames: known.settingNames } : {},
        notes: local ? "Local plugin: the path is on the source machine." : known ? `${known.note} ${elizaosPluginHint(raw)}` : undefined,
        source: src("plugins")
      };
      doc.integrations.push(it);
    }
  }

  const mcp = settings.mcp && typeof settings.mcp === "object" ? (settings.mcp as Json) : undefined;
  if (mcp?.servers && typeof mcp.servers === "object") doc.tools.push(...toolsFromMcpServers(mcp.servers, P, `${basename(path)}#settings.mcp.servers`, { notes }));

  // Other settings are kept for round trips once secret-looking entries are removed.
  const restNames: string[] = [];
  const { mcp: _mcp, nomadAgentId: _id, ...otherSettings } = settings;
  const keptSettings = stripSecrets(otherSettings, restNames, "settings.");
  const mcpRest = mcp ? Object.fromEntries(Object.entries(mcp).filter(([k]) => k !== "servers")) : {};
  if (Object.keys(keptSettings).length || Object.keys(mcpRest).length) x.settings = { ...keptSettings, ...(Object.keys(mcpRest).length ? { mcp: mcpRest } : {}) };

  if (typeof character.modelProvider === "string") {
    const p = PROVIDERS[character.modelProvider.toLowerCase()];
    if (p) doc.models.provider = p;
  }

  const unknownNames: string[] = [];
  const unknown = stripSecrets(Object.fromEntries(Object.entries(character).filter(([k]) => !KNOWN_KEYS.has(k))), unknownNames);
  if (Object.keys(unknown).length && bytes(unknown) <= MAX_EXAMPLES_BYTES) x.unknown = unknown;

  const dropped = [...secretNames, ...restNames, ...unknownNames];
  if (dropped.length) {
    x.secretNames = dropped;
    notes.push({ level: "info", category: "integrations", message: `Secrets are never read or moved. Set these again on the destination: ${dropped.join(", ")}.` });
  }
  if (dropped.some((d) => d.endsWith(PRIORS_OWNER))) {
    notes.push({ level: "warning", category: "permissions", message: "This agent only moved money for named ElizaOS entities (PRIORS_OWNER_ENTITY_IDS). Other platforms use their own approval prompts; that rule does not transfer." });
  }
  const kept = ["topics", "messageExamples", "postExamples", "templates", "username", "characterId"].filter((k) => x[k] !== undefined);
  if (kept.length) notes.push({ level: "info", category: "identity", message: `Kept in the package for ElizaOS round trips, not applied on other platforms: ${kept.join(", ")}.` });
  if (doc.integrations.length) notes.push({ level: "info", category: "integrations", message: "ElizaOS plugins are listed by name; their code and installs do not move." });
  notes.push({ level: "info", category: "memory", message: "ElizaOS runtime memory and conversations live in its database and are not migrated." });

  doc.extensions[X] = x;
  doc.source.location = path;
  return doc;
}

async function locate(root: string, nativeId: string): Promise<string> {
  const files = await characterFiles(root);
  const hit = files.find((f) => f.id === nativeId);
  if (!hit) throw new NomadError(`No ElizaOS character "${nativeId}" in ${root}.`, "not-found");
  return hit.path;
}

function isObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Nomad document -> ElizaOS character. Secrets and references are never written. */
export function documentToCharacter(doc: AgentDocument, mcpServers: Record<string, Record<string, unknown>>): Json {
  const x = (isObject(doc.extensions[X]) ? doc.extensions[X] : {}) as Json;
  const restoredStyle = isObject(x.style) ? x.style : undefined;
  const sys: string[] = [];
  const styleFromDoc: Record<string, string[]> = {};
  for (const i of doc.instructions) {
    if (i.kind === "system") sys.unshift(i.content);
    else if (i.kind === "conventions" && /^Style \((all|chat|post)\)$/.test(i.title ?? "")) {
      const k = /\((\w+)\)/.exec(i.title!)![1];
      styleFromDoc[k] = i.content.split("\n").map((l) => l.replace(/^[-*]\s+/, "")).filter(Boolean);
    } else sys.push(`## ${i.title ?? i.kind}\n\n${i.content}`);
  }
  const persona = doc.identity.persona ?? "";
  const bio = x.bioShape === "array" ? persona.split("\n").filter((l) => l.length) : persona;
  const adjectives = Array.isArray(x.adjectives) ? x.adjectives : doc.identity.tone ? doc.identity.tone.split(/,\s*/).filter(Boolean) : undefined;
  const plugins = doc.integrations.filter((i) => i.kind === "elizaos-plugin").map((i) => i.name);
  const shared = (k: Json) => (typeof k.shared === "boolean" ? { shared: k.shared } : {});
  const knowledge = [...doc.memory.map((m) => m.content.replace(/^[-*]\s+/, "")), ...doc.knowledge.map((k) => ((k as Json).directory === true ? { directory: k.path, ...shared(k as Json) } : { path: k.path, ...shared(k as Json) }))];
  const settings: Json = { ...(isObject(x.settings) ? x.settings : {}) };
  if (Object.keys(mcpServers).length) settings.mcp = { ...(isObject(settings.mcp) ? settings.mcp : {}), servers: mcpServers };
  settings.nomadAgentId = doc.id;
  const out: Json = {
    name: doc.identity.name ?? doc.name,
    ...(typeof x.username === "string" ? { username: x.username } : {}),
    bio,
    ...(sys.length ? { system: sys.join("\n\n") } : {}),
    ...(restoredStyle ? { style: restoredStyle } : Object.keys(styleFromDoc).length ? { style: styleFromDoc } : {}),
    ...(adjectives?.length ? { adjectives } : {}),
    ...(Array.isArray(x.topics) ? { topics: x.topics } : {}),
    ...(x.messageExamples !== undefined ? { messageExamples: x.messageExamples } : {}),
    ...(x.postExamples !== undefined ? { postExamples: x.postExamples } : {}),
    ...(isObject(x.templates) ? { templates: x.templates } : {}),
    ...(knowledge.length ? { knowledge } : {}),
    ...(isObject(x.unknown) ? x.unknown : {}),
    plugins,
    settings
  };
  return out;
}

/** True when an object has a `secrets` key at any depth. */
export function hasSecretsKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasSecretsKey);
  if (!isObject(v)) return false;
  return Object.entries(v).some(([k, c]) => k === "secrets" || hasSecretsKey(c));
}

export const elizaosAdapter: Adapter = {
  info: ELIZAOS_INFO,

  async detect(root) {
    const evidence: string[] = [];
    const files = await characterFiles(root);
    if (files.length) evidence.push(`${files.length} character file(s)`);
    const pkg = await readTextIfExists(join(root, "package.json"));
    if (pkg && /"@elizaos\/(core|cli)"/.test(pkg)) evidence.push("package.json depends on @elizaos");
    const ts = await typescriptCharacters(root);
    if (ts.length) evidence.push(`TypeScript character: ${ts.join(", ")}`);
    const detected = files.length > 0 || evidence.some((e) => e.startsWith("package.json"));
    return { detected, confidence: files.length && evidence.length > 1 ? 0.9 : detected ? 0.6 : 0, evidence };
  },

  async discover(root): Promise<AgentRef[]> {
    const refs: AgentRef[] = [];
    for (const f of await characterFiles(root)) {
      let name = f.id;
      try {
        const st = await fsp.lstat(f.path);
        if (!st.isSymbolicLink() && st.size <= MAX_BYTES) {
          const j = JSON.parse(await fsp.readFile(f.path, "utf8"));
          if (typeof j?.name === "string") name = j.name;
        }
      } catch {
        /* listed by file name */
      }
      refs.push({ nativeId: f.id, name, location: f.path, kind: "main" });
    }
    return refs;
  },

  async read(root, nativeId) {
    const notes: Note[] = [];
    const path = await locate(root, nativeId);
    const st = await fsp.lstat(path);
    if (st.isSymbolicLink()) throw new NomadError(`${basename(path)} is a symlink. Nomad does not follow it.`, "unsafe-path");
    if (st.size > MAX_BYTES) throw new NomadError(`${basename(path)} is larger than 1 MB.`, "too-large");
    const text = await readTextIfExists(path);
    if (text === null) throw new NomadError(`${basename(path)} could not be read.`, "not-found");
    let parsed: ReturnType<typeof parseCharacter>;
    try {
      parsed = parseCharacter(text);
    } catch (e) {
      // The parser's message can quote the file, so only its position is reported.
      const at = /position (\d+)/.exec((e as Error).message)?.[1];
      throw new NomadError(`${basename(path)} is not valid JSON${at ? ` (near character ${at})` : ""}.`, "invalid-character");
    }
    const projectRoot = /\.json$/i.test(root) ? dirname(root) : root;
    for (const ts of await typescriptCharacters(projectRoot)) notes.push({ level: "info", category: "identity", message: `TypeScript character found (${ts}), not imported. Nomad never runs your code.` });
    const doc = characterToDocument(parsed.character, parsed.secretNames, path, notes);
    doc.source.nativeId = nativeId;
    return { doc, sourceFiles: [path], notes };
  },

  async plan(doc, ctx): Promise<PlannedWrite> {
    const notes: Note[] = [];
    const manualSteps: string[] = [];
    const conversions: PlannedWrite["conversions"] = [];
    const unsupported: PlannedWrite["unsupported"] = [];
    const dir = "characters";
    let slug = ctx.targetNativeId ?? safeName((ctx.mode === "copy" && ctx.targetName ? ctx.targetName : doc.name).toLowerCase());
    if (ctx.mode === "copy") {
      let i = 2;
      const base = slug;
      while (await pathExists(join(ctx.root, dir, `${slug}.json`))) slug = `${base}-${i++}`;
    }
    const target = `${dir}/${slug}.json`;
    const existing = await readTextIfExists(join(ctx.root, target));

    const tools = wants(ctx, "tools") ? doc.tools.filter((t) => t.kind === "mcp" && t.mcp) : [];
    // ElizaOS's MCP plugin may not expand ${VAR}: references become manual steps, never values.
    const r = mcpServersFromTools(tools, { platformName: "ElizaOS", envRefStyle: "none" });
    const servers: Record<string, Record<string, unknown>> = {};
    for (const [name, s] of Object.entries(r.servers) as Array<[string, Record<string, unknown>]>) {
      servers[name] = s.url ? { type: "streamable-http", url: s.url } : { type: "stdio", command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
    }
    manualSteps.push(...r.manualSteps);
    unsupported.push(...r.unsupported);
    notes.push(...r.notes);
    for (const t of doc.tools.filter((t) => t.kind !== "mcp")) unsupported.push({ category: "tools", item: t.name, reason: "Only MCP servers can be written to an ElizaOS character." });
    if (Object.keys(servers).length) {
      manualSteps.push('Add the ElizaOS MCP plugin "@elizaos/plugin-mcp" to the character\'s plugins and install it. Nomad does not add plugins.');
      conversions.push({ category: "tools", item: `${Object.keys(servers).length} MCP server(s)`, from: "MCP servers", to: "settings.mcp.servers" });
    }
    const priors = tools.some((t) => knownServerId(t) === "priors") || doc.integrations.some((i) => i.name === "@priors/plugin-elizaos");
    if (priors) {
      manualSteps.push("Priors' documentation warns that ElizaOS keeps a character's settings in its database in plain text and returns them from its agents API. Put only a key file path in PRIORS_KEY_FILE, never the key itself.");
    }
    manualSteps.push("Set secrets in your own ElizaOS environment. Nomad never writes them into the character.");

    const docForWrite: AgentDocument = {
      ...doc,
      instructions: wants(ctx, "instructions") ? doc.instructions : [],
      memory: wants(ctx, "memory") ? doc.memory : [],
      knowledge: wants(ctx, "knowledge") ? doc.knowledge : [],
      integrations: wants(ctx, "integrations") ? doc.integrations : []
    };
    const character = documentToCharacter(docForWrite, servers);
    const folded = doc.instructions.filter((i) => i.kind !== "system" && !/^Style \((all|chat|post)\)$/.test(i.title ?? ""));
    if (folded.length && wants(ctx, "instructions")) conversions.push({ category: "instructions", item: `${folded.length} section(s)`, from: "instructions", to: "system (with headings)" });
    if (doc.memory.length && wants(ctx, "memory")) conversions.push({ category: "memory", item: `${doc.memory.length} entries`, from: "memory", to: "knowledge strings" });
    for (const k of doc.knowledge) manualSteps.push(`Copy the knowledge file ${k.path} into the ElizaOS project if it is not there.`);
    for (const i of doc.integrations.filter((x) => x.kind !== "elizaos-plugin")) manualSteps.push(`${i.name} was set up on the source. Find or install an ElizaOS plugin for it; Nomad never installs plugins.`);
    for (const p of doc.integrations.filter((x) => x.kind === "elizaos-plugin" && (x.name.startsWith(".") || x.name.startsWith("/")))) {
      notes.push({ level: "warning", category: "integrations", message: `Plugin ${p.name} is a local path on the source machine.` });
    }
    const x = isObject(doc.extensions[X]) ? (doc.extensions[X] as Json) : {};
    if (Array.isArray(x.secretNames) && x.secretNames.length) manualSteps.push(`Set again in ElizaOS: ${(x.secretNames as string[]).join(", ")}. ${(x.secretNames as string[]).some((n) => n.endsWith(PRIORS_OWNER)) ? "Set PRIORS_OWNER_ENTITY_IDS to your own entity ids; never * unless you mean anyone." : ""}`.trim());
    if (wants(ctx, "skills")) for (const s of doc.skills) unsupported.push({ category: "skills", item: s.name, reason: "ElizaOS characters have no skills.", alternative: "Skill instructions are in the package and the report." });
    if (wants(ctx, "workflows")) for (const w of doc.workflows) unsupported.push({ category: "workflows", item: w.name, reason: "ElizaOS characters have no scheduler." });
    if (wants(ctx, "permissions") && doc.permissions.rules.length) unsupported.push({ category: "permissions", item: `${doc.permissions.rules.length} rule(s)`, reason: "ElizaOS characters have no permission rules." });
    if (wants(ctx, "models") && doc.models.preferred) manualSteps.push(`Choose ${doc.models.preferred} (or the closest model) through a model plugin in ElizaOS.`);

    const strategy = existing !== null && ctx.mode === "merge" ? "merge-json" : "replace";
    const files: DesiredFile[] = [{ path: target, content: JSON.stringify(character, null, 2) + "\n", strategy, agentOwned: true, component: "identity", description: `ElizaOS character ${target}` }];
    return { nativeId: slug, files, notes, manualSteps, conversions, unsupported };
  },

  async verify(doc, root, nativeId, ctx): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = [];
    const path = join(root, "characters", `${nativeId}.json`);
    const text = await readTextIfExists(path);
    if (text === null) return [{ name: "Character file written", ok: false, detail: "File is missing" }];
    let raw: Json;
    try {
      raw = JSON.parse(text);
    } catch {
      return [{ name: "Character file parses", ok: false }];
    }
    checks.push({ name: "No secrets in the character", ok: !hasSecretsKey(raw) });
    const notes: Note[] = [];
    const got = characterToDocument(parseCharacter(text).character, [], path, notes);
    checks.push({ name: "Name kept", ok: got.name === (doc.identity.name ?? doc.name) });
    if (wants(ctx, "identity") && doc.identity.persona) checks.push({ name: "Bio kept", ok: (got.identity.persona ?? "").replace(/\n/g, "") === doc.identity.persona.replace(/\n/g, "") });
    const sys = doc.instructions.find((i) => i.kind === "system");
    if (sys && wants(ctx, "instructions")) checks.push({ name: "System prompt kept", ok: (got.instructions.find((i) => i.kind === "system")?.content ?? "").includes(sys.content) });
    const plugins = doc.integrations.filter((i) => i.kind === "elizaos-plugin").map((i) => i.name);
    if (wants(ctx, "integrations")) checks.push({ name: "Plugins kept in order", ok: JSON.stringify(got.integrations.map((i) => i.name)) === JSON.stringify(plugins) });
    if (wants(ctx, "tools")) {
      const expected = doc.tools.filter((t) => t.kind === "mcp" && t.enabled !== false).map((t) => t.name);
      const names = new Set(got.tools.map((t) => t.name));
      const missing = expected.filter((n) => !names.has(n));
      checks.push({ name: "MCP servers written", ok: !missing.length, detail: missing.length ? `Missing: ${missing.join(", ")}` : undefined });
    }
    return checks;
  }
};

