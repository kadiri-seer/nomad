import type { AgentDocument, EnvValue } from "@nomad/schema";
import { redactText, scanText, isSensitiveEnvKey, looksLikeSecretValue, isSensitiveFile, type SecretFinding } from "./secrets";

export interface SensitiveFileFinding {
  file: string;
  reason: string;
}

export interface DocumentScan {
  findings: SecretFinding[];
  sensitiveFiles: SensitiveFileFinding[];
  /** Secret values present in tool configuration (env or headers). */
  inlineSecretValues: Array<{ tool: string; key: string; location: "env" | "headers" }>;
  clean: boolean;
}

/** Visit every text field of a document with a pseudo path. */
export function visitText(doc: AgentDocument, fn: (path: string, text: string) => void): void {
  if (doc.identity.persona) fn("identity/persona.md", doc.identity.persona);
  if (doc.identity.description) fn("identity/description", doc.identity.description);
  if (doc.description) fn("description", doc.description);
  for (const i of doc.instructions) fn(`instructions/${i.id}.md`, i.content);
  for (const m of doc.memory) fn(`memory/${m.id}.md`, m.content);
  for (const s of doc.skills) {
    fn(`skills/${s.name}/instructions.md`, s.instructions);
    for (const f of s.files) if (f.encoding === "utf8") fn(`skills/${s.name}/${f.path}`, f.content);
  }
  for (const w of doc.workflows) {
    for (const a of w.actions) if (a.kind === "prompt") fn(`workflows/${w.id}.prompt`, a.text);
  }
  for (const t of doc.tools) {
    if (t.mcp?.args?.length) fn(`tools/${t.name}/args`, t.mcp.args.join(" "));
    if (t.mcp?.url) fn(`tools/${t.name}/url`, t.mcp.url);
  }
  for (const it of doc.integrations) fn(`integrations/${it.name}.json`, JSON.stringify(it.config));
  for (const f of doc.files) if (f.encoding === "utf8") fn(`files/${f.path}`, f.content);
}

export function scanDocument(doc: AgentDocument): DocumentScan {
  const findings: SecretFinding[] = [];
  visitText(doc, (path, text) => findings.push(...scanText(text, path)));
  const sensitiveFiles: SensitiveFileFinding[] = [];
  for (const f of doc.files) if (isSensitiveFile(f.path)) sensitiveFiles.push({ file: `files/${f.path}`, reason: "Credential or key file" });
  for (const s of doc.skills)
    for (const f of s.files)
      if (isSensitiveFile(f.path)) sensitiveFiles.push({ file: `skills/${s.name}/${f.path}`, reason: "Credential or key file" });
  const inlineSecretValues: DocumentScan["inlineSecretValues"] = [];
  for (const t of doc.tools) {
    for (const [loc, rec] of [
      ["env", t.mcp?.env ?? {}],
      ["headers", t.mcp?.headers ?? {}]
    ] as const) {
      for (const [k, v] of Object.entries(rec)) {
        if ("value" in v && (isSensitiveEnvKey(k) || looksLikeSecretValue(v.value))) {
          inlineSecretValues.push({ tool: t.name, key: k, location: loc });
        }
      }
    }
  }
  return {
    findings,
    sensitiveFiles,
    inlineSecretValues,
    clean: findings.length === 0 && sensitiveFiles.length === 0 && inlineSecretValues.length === 0
  };
}

export interface SanitizeOptions {
  /** Keep secret values. Off by default, and always reported. */
  includeSecrets?: boolean;
  /** Keep sensitive files (.env, keys). Off by default. */
  includeSensitiveFiles?: boolean;
}

export interface SanitizeReport {
  redactedText: number;
  strippedEnvValues: Array<{ tool: string; key: string }>;
  removedFiles: string[];
  includedSecrets: boolean;
}

function stripRecord(tool: string, rec: Record<string, EnvValue>, report: SanitizeReport): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const [k, v] of Object.entries(rec)) {
    if ("value" in v && (isSensitiveEnvKey(k) || looksLikeSecretValue(v.value))) {
      out[k] = { secretRef: k, redacted: true };
      report.strippedEnvValues.push({ tool, key: k });
    } else out[k] = v;
  }
  return out;
}

/**
 * Remove credentials from a document. Text secrets are replaced with markers,
 * tool environment secrets become references the user reconnects later, and
 * credential files are dropped. Nothing is removed silently: the report lists it all.
 */
export function sanitizeDocument(doc: AgentDocument, options: SanitizeOptions = {}): { doc: AgentDocument; report: SanitizeReport } {
  const report: SanitizeReport = { redactedText: 0, strippedEnvValues: [], removedFiles: [], includedSecrets: !!options.includeSecrets };
  if (options.includeSecrets) {
    if (options.includeSensitiveFiles) return { doc, report };
  }
  const red = (s: string) => {
    if (options.includeSecrets) return s;
    const r = redactText(s);
    report.redactedText += r.count;
    return r.text;
  };
  const keepFile = (path: string) => {
    if (options.includeSensitiveFiles || !isSensitiveFile(path)) return true;
    report.removedFiles.push(path);
    return false;
  };
  const out: AgentDocument = {
    ...doc,
    description: doc.description === undefined ? undefined : red(doc.description),
    identity: {
      ...doc.identity,
      persona: doc.identity.persona === undefined ? undefined : red(doc.identity.persona),
      description: doc.identity.description === undefined ? undefined : red(doc.identity.description)
    },
    instructions: doc.instructions.map((i) => ({ ...i, content: red(i.content) })),
    memory: doc.memory.map((m) => ({ ...m, content: red(m.content) })),
    skills: doc.skills.map((s) => ({
      ...s,
      instructions: red(s.instructions),
      files: s.files
        .filter((f) => keepFile(`skills/${s.name}/${f.path}`))
        .map((f) => (f.encoding === "utf8" ? { ...f, content: red(f.content) } : f))
    })),
    workflows: doc.workflows.map((w) => ({
      ...w,
      actions: w.actions.map((a) => (a.kind === "prompt" ? { ...a, text: red(a.text) } : a))
    })),
    tools: doc.tools.map((t) =>
      t.mcp && !options.includeSecrets
        ? {
            ...t,
            mcp: {
              ...t.mcp,
              args: t.mcp.args.map(red),
              url: t.mcp.url === undefined ? undefined : red(t.mcp.url),
              env: stripRecord(t.name, t.mcp.env, report),
              headers: stripRecord(t.name, t.mcp.headers, report)
            }
          }
        : t
    ),
    integrations: doc.integrations.map((it) => ({ ...it, config: JSON.parse(red(JSON.stringify(it.config))) })),
    files: doc.files.filter((f) => keepFile(`files/${f.path}`)).map((f) => (f.encoding === "utf8" ? { ...f, content: red(f.content) } : f))
  };
  return { doc: out, report };
}
