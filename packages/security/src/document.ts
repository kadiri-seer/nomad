import type { AgentDocument, EnvValue } from "@nomad/schema";
import { redactText, redactLaunchField, redactWalletText, redactWalletLaunchField, scanText, scanMcpLaunchFields, isSensitiveEnvKey, isRpcEnvKey, isPublicRpcUrl, looksLikeSecretValue, isSensitiveFile, isMnemonic, type SecretFinding } from "./secrets";

const EVM_KEY_VALUE = /\b0x[0-9a-fA-F]{64}\b/;

/** True when an env or header value must not be copied: a credential by name or shape, a wallet key, or a private RPC URL. */
export function isSecretEnvEntry(key: string, value: string): boolean {
  if (isSensitiveEnvKey(key) || looksLikeSecretValue(value) || EVM_KEY_VALUE.test(value)) return true;
  // "off" turns an RPC (or service) off, as Ostra's settings allow: it is a setting, not an address.
  return isRpcEnvKey(key) && !isPublicRpcUrl(value) && value.trim().toLowerCase() !== "off";
}

/** Names that hold wallet key material: PRIVATE_KEY, WALLET_SECRET, SIGNER_KEY, HEDGEHOOD_SESSION_KEY and similar. */
const WALLET_ENV_NAME = /(PRIVATE|WALLET|SIGNER|MNEMONIC|SEED|OWNER|PAYER|SESSION)/i;
/**
 * Other names that end in KEY (AGENT_KEY, BOT_KEY): a raw wallet-shaped value under them is a wallet key too.
 * Names that say API, access, auth, token, client, license or public are service keys, not wallets.
 */
const KEY_ENV_NAME = /(^|_)KEY$/i;
const SERVICE_KEY_NAME = /(API|ACCESS|AUTH|TOKEN|CLIENT|LICEN[CS]E|PUBLIC|PUB)/i;
const BARE_HEX_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;
/** A Solana secret key in base58 (64 bytes). */
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;
/** A Solana secret key as a JSON array of 64 bytes. */
const BYTE_ARRAY_KEY = /^\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]$/;

/**
 * True when an env or header value is wallet key material: a 0x-prefixed 32-byte hex value,
 * a recovery phrase, or a raw key under a wallet name (or another name ending in KEY that is not a
 * service key). These are never written as values,
 * even with --include-secrets, because a leaked wallet key cannot be revoked.
 */
export function isWalletEnvEntry(key: string, value: string): boolean {
  const v = value.trim();
  if (EVM_KEY_VALUE.test(v) || isMnemonic(v) || redactWalletText(v).count > 0) return true;
  const walletName = WALLET_ENV_NAME.test(key) || (KEY_ENV_NAME.test(key) && !SERVICE_KEY_NAME.test(key));
  return walletName && (BARE_HEX_KEY.test(v) || BASE58_KEY.test(v) || BYTE_ARRAY_KEY.test(v));
}

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
  // Tool launch fields (args, url, headers) are scanned without context in scanDocument.
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
  for (const t of doc.tools) {
    if (!t.mcp) continue;
    const literal = (rec: Record<string, EnvValue>) => Object.fromEntries(Object.entries(rec).flatMap(([k, v]) => ("value" in v ? [[k, v.value]] : [])));
    // env values are reported below as inline secrets, so only launch text is scanned here.
    findings.push(...scanMcpLaunchFields(t.name, { args: t.mcp.args, url: t.mcp.url, headers: literal(t.mcp.headers) }).filter((f) => !f.file.includes("/headers/")));
  }
  const inlineSecretValues: DocumentScan["inlineSecretValues"] = [];
  for (const t of doc.tools) {
    for (const [loc, rec] of [
      ["env", t.mcp?.env ?? {}],
      ["headers", t.mcp?.headers ?? {}]
    ] as const) {
      for (const [k, v] of Object.entries(rec)) {
        if ("value" in v && isSecretEnvEntry(k, v.value)) {
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
  /** Wallet keys and recovery phrases left out although secrets were included. */
  walletKeysKept: number;
}

function stripRecord(tool: string, rec: Record<string, EnvValue>, report: SanitizeReport, isSecret: (k: string, v: string) => boolean): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const [k, v] of Object.entries(rec)) {
    if ("value" in v && isSecret(k, v.value)) {
      out[k] = { secretRef: k, redacted: true };
      report.strippedEnvValues.push({ tool, key: k });
      if (report.includedSecrets) report.walletKeysKept++;
    } else out[k] = v;
  }
  return out;
}

/**
 * Remove credentials from a document. Text secrets are replaced with markers,
 * tool environment secrets become references the user reconnects later, and
 * credential files are dropped. Nothing is removed silently: the report lists it all.
 * With includeSecrets, other secrets are kept but wallet keys and recovery phrases are
 * still removed everywhere: they cannot be revoked once they leak.
 */
export function sanitizeDocument(doc: AgentDocument, options: SanitizeOptions = {}): { doc: AgentDocument; report: SanitizeReport } {
  const include = !!options.includeSecrets;
  const report: SanitizeReport = { redactedText: 0, strippedEnvValues: [], removedFiles: [], includedSecrets: include, walletKeysKept: 0 };
  const red = (s: string) => {
    const r = include ? redactWalletText(s) : redactText(s);
    report.redactedText += r.count;
    if (include) report.walletKeysKept += r.count;
    return r.text;
  };
  // Launch fields: a wallet key is removed even without surrounding words.
  const launch = (s: string) => {
    const r = include ? redactWalletLaunchField(s) : redactLaunchField(s);
    report.redactedText += r.count;
    if (include) report.walletKeysKept += r.count;
    return r.text;
  };
  const isSecret = include ? isWalletEnvEntry : isSecretEnvEntry;
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
      t.mcp
        ? {
            ...t,
            mcp: {
              ...t.mcp,
              args: t.mcp.args.map(launch),
              url: t.mcp.url === undefined ? undefined : launch(t.mcp.url),
              env: stripRecord(t.name, t.mcp.env, report, isSecret),
              headers: stripRecord(t.name, t.mcp.headers, report, isSecret)
            }
          }
        : t
    ),
    integrations: doc.integrations.map((it) => ({ ...it, config: JSON.parse(red(JSON.stringify(it.config))) })),
    files: doc.files.filter((f) => keepFile(`files/${f.path}`)).map((f) => (f.encoding === "utf8" ? { ...f, content: red(f.content) } : f))
  };
  return { doc: out, report };
}
