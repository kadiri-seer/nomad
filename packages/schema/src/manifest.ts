import { z } from "zod";
import { AgentId, Extensions, IsoDate, ModelPreferences, SourceInfo, SUPPORTED_SCHEMA_VERSIONS } from "./uaf";

/**
 * manifest.json of an .agentpack archive. It describes what is in the package and
 * where each component lives. Content itself lives in the referenced files.
 */
export const PACKAGE_FORMAT = "nomad.agentpack" as const;

const FileRef = z.string().min(1);

export const PackageManifest = z
  .object({
    format: z.literal(PACKAGE_FORMAT),
    schemaVersion: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    id: AgentId,
    name: z.string().min(1),
    description: z.string().optional(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
    exportedAt: IsoDate,
    packageVersion: z.number().int().positive(),
    generator: z.object({ name: z.string(), version: z.string() }).passthrough(),
    source: SourceInfo,
    capabilities: z.array(z.string()).default([]),
    models: ModelPreferences.optional(),
    identity: FileRef.optional(),
    instructions: z
      .array(z.object({ id: z.string(), kind: z.string(), title: z.string().optional(), path: FileRef }).passthrough())
      .default([]),
    memory: z.object({ index: FileRef, count: z.number().int().nonnegative() }).passthrough().optional(),
    skills: z.array(z.object({ name: z.string(), path: FileRef }).passthrough()).default([]),
    tools: z.array(z.object({ name: z.string(), path: FileRef }).passthrough()).default([]),
    integrations: FileRef.optional(),
    workflows: z.array(z.object({ id: z.string(), name: z.string(), path: FileRef }).passthrough()).default([]),
    permissions: FileRef.optional(),
    knowledge: FileRef.optional(),
    files: z.array(z.object({ path: FileRef, sha256: z.string(), size: z.number().int().nonnegative() }).passthrough()).default([]),
    history: FileRef.optional(),
    secrets: z
      .object({
        included: z.boolean(),
        redactedCount: z.number().int().nonnegative(),
        references: z.array(z.string()).default([])
      })
      .passthrough()
      .default({ included: false, redactedCount: 0, references: [] }),
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        files: z.record(z.string(), z.string())
      })
      .passthrough()
      .optional(),
    extensions: Extensions
  })
  .passthrough();
export type PackageManifest = z.infer<typeof PackageManifest>;
