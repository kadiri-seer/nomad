import type { AgentDocument, ValidationIssue } from "@nomad/schema";
import { disableWorkflows, utf8 } from "@nomad/core";
import { sanitizeDocument, scanDocument, type DocumentScan, type SanitizeReport } from "@nomad/security";
import { filesToDocument } from "./layout";
import { isInterchange, readInterchange, writeInterchange } from "./interchange";
import { isNomadPack, NOMAD_EXTENSION, NOMAD_MANIFEST, readNomadPack, signedPayload, writeNomadPack, type NomadManifest } from "./nomadpack";
import { ArchiveError, createZip, DEFAULT_LIMITS, extractEntries, extensionOf, EXECUTABLE_EXTENSIONS, type ArchiveLimits } from "./zip";

/** Nomad packages use .nomad. Older .agentpack files (format 1) are still read. */
export const PACKAGE_EXTENSION = NOMAD_EXTENSION;
export const LEGACY_PACKAGE_EXTENSION = ".agentpack";
export const PACKAGE_EXTENSIONS = [".nomad", ".agentpack", ".jetpack"];

export interface Signature {
  alg: "ed25519";
  key: string;
  fingerprint: string;
  value: string;
}

export interface PackOptions {
  includeSecrets?: boolean;
  includeSensitiveFiles?: boolean;
  /** Include knowledge and arbitrary files. When false they are dropped from the package. */
  includeFiles?: boolean;
  exportedAt?: string;
  /** Sign the manifest. Receives the canonical payload, returns the signature. */
  sign?: (payload: string) => Signature;
}

export interface PackResult {
  bytes: Uint8Array;
  manifest: NomadManifest;
  files: Map<string, Uint8Array>;
  scan: DocumentScan;
  sanitize: SanitizeReport;
}

export function prepareForExport(doc: AgentDocument, options: PackOptions = {}) {
  const scan = scanDocument(doc);
  let working = doc;
  if (options.includeFiles === false) working = { ...working, files: [], knowledge: [] };
  const { doc: clean, report } = sanitizeDocument(working, {
    includeSecrets: options.includeSecrets,
    includeSensitiveFiles: options.includeSensitiveFiles
  });
  return { doc: clean, scan, sanitize: report };
}

/** Build a .nomad package. */
export function packAgent(doc: AgentDocument, options: PackOptions = {}): PackResult {
  const { doc: clean, scan, sanitize } = prepareForExport(doc, options);
  const secrets = { included: !!options.includeSecrets, redacted: sanitize.redactedText + sanitize.strippedEnvValues.length, reconnect: sanitize.strippedEnvValues.map((s) => `${s.tool}:${s.key}`) };
  const { files, manifest } = writeNomadPack(clean, { exportedAt: options.exportedAt, secrets: secrets.included || secrets.redacted ? secrets : undefined });
  if (options.sign) {
    manifest.signature = options.sign(signedPayload(manifest));
    files.set(NOMAD_MANIFEST, utf8(JSON.stringify(JSON.parse(JSON.stringify(manifest)), null, 2) + "\n"));
  }
  return { bytes: createZip(files), manifest, files, scan, sanitize };
}

export interface UnpackOptions {
  limits?: Partial<ArchiveLimits>;
  includeSecrets?: boolean;
  verifyIntegrity?: boolean;
  /** Check a signature. Returns true when valid. Leave out where no crypto is available. */
  verifySignature?: (payload: string, signature: Signature) => boolean;
}

export type PackageFormat = "nomad" | "agentpack" | "interchange";

export interface PackageInfo {
  format: PackageFormat;
  exportedAt?: string;
  secretsIncluded: boolean;
  redacted: number;
  reconnect: string[];
  integrity: boolean;
  signature: null | { fingerprint: string; key: string; verified: boolean | null; payload: string; value: string };
}

export interface UnpackResult {
  ok: boolean;
  doc: AgentDocument | null;
  issues: ValidationIssue[];
  warnings: string[];
  scan: DocumentScan | null;
  sanitize: SanitizeReport | null;
  executableFiles: string[];
  fileCount: number;
  totalBytes: number;
  format?: PackageFormat;
  info?: PackageInfo;
}

/** Validate and read a package (.nomad, .agentpack or .jetpack). Nothing is written to disk. */
export function unpackAgent(bytes: Uint8Array, options: UnpackOptions = {}): UnpackResult {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  let files: Map<string, Uint8Array>;
  try {
    files = extractEntries(bytes, limits);
  } catch (e) {
    if (e instanceof ArchiveError) {
      return { ok: false, doc: null, issues: [{ path: e.entry ?? "(archive)", message: `${e.message} [${e.code}]` }], warnings: [], scan: null, sanitize: null, executableFiles: [], fileCount: 0, totalBytes: 0 };
    }
    throw e;
  }
  return unpackFiles(files, options);
}

export function detectFormat(files: Map<string, Uint8Array>): PackageFormat | null {
  if (isNomadPack(files)) return "nomad";
  if (files.has("manifest.json")) return "agentpack";
  if (isInterchange(files) || files.has("AGENTS.md")) return "interchange";
  return null;
}

export function unpackFiles(files: Map<string, Uint8Array>, options: UnpackOptions = {}): UnpackResult {
  const executableFiles = [...files.keys()].filter((p) => EXECUTABLE_EXTENSIONS.has(extensionOf(p)));
  const totalBytes = [...files.values()].reduce((n, d) => n + d.length, 0);
  const base = { executableFiles, fileCount: files.size, totalBytes };
  const format = detectFormat(files);
  if (!format) return { ok: false, doc: null, issues: [{ path: "(archive)", message: "Not an agent package: no nomad.json, manifest.json, jetpack.json or AGENTS.md" }], warnings: [], scan: null, sanitize: null, ...base };

  let doc: AgentDocument | null = null;
  let issues: ValidationIssue[] = [];
  let warnings: string[] = [];
  let info: PackageInfo = { format, secretsIncluded: false, redacted: 0, reconnect: [], integrity: format !== "interchange", signature: null };

  if (format === "nomad") {
    const r = readNomadPack(files, { verifyIntegrity: options.verifyIntegrity });
    doc = r.doc;
    issues = r.issues;
    warnings = r.warnings;
    const m = r.manifest;
    if (m) {
      info = { ...info, exportedAt: m.exported, secretsIncluded: !!m.secrets?.included, redacted: m.secrets?.redacted ?? 0, reconnect: m.secrets?.reconnect ?? [] };
      if (m.signature) {
        const payload = signedPayload(m);
        let verified: boolean | null = null;
        if (options.verifySignature) {
          try {
            verified = options.verifySignature(payload, m.signature);
          } catch {
            verified = false;
          }
        }
        info.signature = { fingerprint: m.signature.fingerprint, key: m.signature.key, verified, payload, value: m.signature.value };
        if (verified === false) issues.push({ path: `${NOMAD_MANIFEST}.signature`, message: "The signature does not match the package (it was changed after signing)" });
      }
    }
    if (issues.length) doc = null;
  } else if (format === "agentpack") {
    const r = filesToDocument(files, { verifyIntegrity: options.verifyIntegrity });
    doc = r.doc;
    issues = r.issues;
    warnings = r.warnings;
    if (r.manifest) info = { ...info, exportedAt: r.manifest.exportedAt, secretsIncluded: r.manifest.secrets.included, redacted: r.manifest.secrets.redactedCount, reconnect: r.manifest.secrets.references };
  } else {
    const r = readInterchange(files);
    doc = r.doc;
    issues = r.issues;
    warnings = ["Interchange archive (.jetpack): read without integrity hashes, which this format does not carry.", ...r.warnings];
  }

  if (!doc) return { ok: false, doc: null, issues, warnings, scan: null, sanitize: null, format, info, ...base };
  const scan = scanDocument(doc);
  const { doc: clean, report } = sanitizeDocument(disableWorkflows(doc), { includeSecrets: options.includeSecrets });
  if (executableFiles.length) warnings.push(`Package contains ${executableFiles.length} script file(s). They are stored but never executed by Nomad.`);
  return { ok: true, doc: clean, issues: [], warnings, scan, sanitize: report, format, info, ...base };
}

/** Export as an interchange archive (.jetpack) for other tools. */
export function packInterchange(doc: AgentDocument, options: PackOptions = {}) {
  const { doc: clean, scan, sanitize } = prepareForExport(doc, options);
  const r = writeInterchange(clean, { exportedAt: options.exportedAt });
  return { bytes: createZip(r.files), files: r.files, carried: r.carried, dropped: r.dropped, scan, sanitize };
}
