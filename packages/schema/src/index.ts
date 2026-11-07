import { z } from "zod";
import { AgentDocument, SUPPORTED_SCHEMA_VERSIONS, UAF_SCHEMA_VERSION } from "./uaf";
import { PackageManifest } from "./manifest";

export * from "./uaf";
export * from "./manifest";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T; issues: [] } | { ok: false; issues: ValidationIssue[] };

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
}

/**
 * Upgrade a raw document from an older schema version to the current one.
 * Version 1.0 is the first public version, so this only normalizes the field.
 * Future versions add explicit steps here so older packages keep loading.
 */
export function upgradeDocument(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const doc = { ...(raw as Record<string, unknown>) };
  if (doc.schemaVersion === undefined) doc.schemaVersion = UAF_SCHEMA_VERSION;
  if (doc.schemaVersion === "1") doc.schemaVersion = "1.0";
  return doc;
}

export function validateDocument(raw: unknown): ValidationResult<AgentDocument> {
  const upgraded = upgradeDocument(raw) as Record<string, unknown>;
  if (
    upgraded &&
    typeof upgraded.schemaVersion === "string" &&
    !(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(upgraded.schemaVersion)
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "schemaVersion",
          message: `Schema version ${upgraded.schemaVersion} is newer than this version of Nomad supports (${SUPPORTED_SCHEMA_VERSIONS.join(", ")}). Update Nomad to read it.`
        }
      ]
    };
  }
  const parsed = AgentDocument.safeParse(upgraded);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };
  return { ok: true, value: parsed.data, issues: [] };
}

export function validateManifest(raw: unknown): ValidationResult<PackageManifest> {
  const parsed = PackageManifest.safeParse(upgradeDocument(raw));
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };
  return { ok: true, value: parsed.data, issues: [] };
}

export function parseDocument(raw: unknown): AgentDocument {
  const r = validateDocument(raw);
  if (!r.ok) {
    throw new Error("Invalid agent document: " + r.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  }
  return r.value;
}

/** JSON Schema (draft 2020-12) of the document and manifest, generated from the Zod definitions. */
export function jsonSchemas() {
  return {
    agentDocument: z.toJSONSchema(AgentDocument, { io: "input", unrepresentable: "any" }),
    packageManifest: z.toJSONSchema(PackageManifest, { io: "input", unrepresentable: "any" })
  };
}
