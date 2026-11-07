import type { AgentDocument, PackageManifest, ValidationIssue } from "@nomad/schema";
import { disableWorkflows, utf8 } from "@nomad/core";
import { sanitizeDocument, scanDocument, type DocumentScan, type SanitizeReport } from "@nomad/security";
import { documentToFiles, filesToDocument } from "./layout";
import { ArchiveError, createZip, DEFAULT_LIMITS, extractEntries, extensionOf, EXECUTABLE_EXTENSIONS, type ArchiveLimits } from "./zip";

export const PACKAGE_EXTENSION = ".agentpack";

export interface PackOptions {
  includeSecrets?: boolean;
  includeSensitiveFiles?: boolean;
  /** Include knowledge and arbitrary files. When false they are dropped from the package. */
  includeFiles?: boolean;
  exportedAt?: string;
}

export interface PackResult {
  bytes: Uint8Array;
  manifest: PackageManifest;
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

export function packAgent(doc: AgentDocument, options: PackOptions = {}): PackResult {
  const { doc: clean, scan, sanitize } = prepareForExport(doc, options);
  const { manifest, files } = documentToFiles(clean, { exportedAt: options.exportedAt });
  manifest.secrets = {
    included: !!options.includeSecrets,
    redactedCount: sanitize.redactedText + sanitize.strippedEnvValues.length,
    references: sanitize.strippedEnvValues.map((s) => `${s.tool}:${s.key}`)
  };
  files.set("manifest.json", utf8(JSON.stringify(manifest, null, 2) + "\n"));
  return { bytes: createZip(files), manifest, files, scan, sanitize };
}

export interface UnpackOptions {
  limits?: Partial<ArchiveLimits>;
  includeSecrets?: boolean;
  verifyIntegrity?: boolean;
}

export interface UnpackResult {
  ok: boolean;
  doc: AgentDocument | null;
  manifest: PackageManifest | null;
  issues: ValidationIssue[];
  warnings: string[];
  scan: DocumentScan | null;
  sanitize: SanitizeReport | null;
  executableFiles: string[];
  fileCount: number;
  totalBytes: number;
}

/** Validate and read an .agentpack. Nothing is written to disk. */
export function unpackAgent(bytes: Uint8Array, options: UnpackOptions = {}): UnpackResult {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  let files: Map<string, Uint8Array>;
  try {
    files = extractEntries(bytes, limits);
  } catch (e) {
    if (e instanceof ArchiveError) {
      return {
        ok: false,
        doc: null,
        manifest: null,
        issues: [{ path: e.entry ?? "(archive)", message: `${e.message} [${e.code}]` }],
        warnings: [],
        scan: null,
        sanitize: null,
        executableFiles: [],
        fileCount: 0,
        totalBytes: 0
      };
    }
    throw e;
  }
  return unpackFiles(files, options);
}

export function unpackFiles(files: Map<string, Uint8Array>, options: UnpackOptions = {}): UnpackResult {
  const executableFiles = [...files.keys()].filter((p) => EXECUTABLE_EXTENSIONS.has(extensionOf(p)));
  const totalBytes = [...files.values()].reduce((n, d) => n + d.length, 0);
  const read = filesToDocument(files, { verifyIntegrity: options.verifyIntegrity });
  if (!read.doc) {
    return { ok: false, doc: null, manifest: read.manifest, issues: read.issues, warnings: read.warnings, scan: null, sanitize: null, executableFiles, fileCount: files.size, totalBytes };
  }
  const scan = scanDocument(read.doc);
  const { doc, report } = sanitizeDocument(disableWorkflows(read.doc), { includeSecrets: options.includeSecrets });
  const warnings = [...read.warnings];
  if (executableFiles.length) warnings.push(`Package contains ${executableFiles.length} script file(s). They are stored but never executed by Nomad.`);
  return { ok: true, doc, manifest: read.manifest, issues: [], warnings, scan, sanitize: report, executableFiles, fileCount: files.size, totalBytes };
}
