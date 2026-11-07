import { z } from "zod";

/**
 * Universal Agent Format (UAF)
 *
 * The platform independent representation of an agent. Every adapter reads its
 * native configuration into an `AgentDocument` and writes an `AgentDocument`
 * back into its native layout. Packages (.agentpack) are a file serialization
 * of the same document.
 */

export const UAF_SCHEMA_VERSION = "1.0" as const;
export const SUPPORTED_SCHEMA_VERSIONS = ["1.0"] as const;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const AgentId = z.string().regex(ULID_RE, "Agent identifiers are ULIDs");
export type AgentId = z.infer<typeof AgentId>;

export const IsoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date");

/** Namespaced extension fields: `x-<namespace>` keys hold platform specific metadata. */
export const Extensions = z
  .record(z.string().regex(/^x-[a-z0-9][a-z0-9._-]*$/i, "Extension keys must look like x-<namespace>"), z.unknown())
  .default({});
export type Extensions = z.infer<typeof Extensions>;

export const Provenance = z
  .object({
    platform: z.string(),
    path: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
    note: z.string().optional()
  })
  .passthrough();
export type Provenance = z.infer<typeof Provenance>;

export const Identity = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    persona: z.string().optional(),
    tone: z.string().optional(),
    emoji: z.string().optional(),
    avatar: z.string().optional().describe("Path of the avatar inside files/"),
    extensions: Extensions
  })
  .passthrough();
export type Identity = z.infer<typeof Identity>;

export const ModelPreferences = z
  .object({
    preferred: z.string().optional(),
    provider: z.string().optional(),
    fallbacks: z.array(z.string()).default([]),
    reasoningEffort: z.string().optional(),
    notes: z.string().optional()
  })
  .passthrough();
export type ModelPreferences = z.infer<typeof ModelPreferences>;

export const InstructionKind = z.enum([
  "system",
  "agent",
  "custom",
  "user-context",
  "conventions",
  "heartbeat",
  "bootstrap",
  "command"
]);
export type InstructionKind = z.infer<typeof InstructionKind>;

export const Instruction = z
  .object({
    id: z.string().min(1),
    kind: InstructionKind,
    title: z.string().optional(),
    content: z.string(),
    source: Provenance.optional()
  })
  .passthrough();
export type Instruction = z.infer<typeof Instruction>;

export const MemoryKind = z.enum([
  "profile",
  "preference",
  "fact",
  "project",
  "instruction",
  "note",
  "summary",
  "daily-log",
  "document"
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryScope = z.enum(["user", "agent", "project"]);

export const MemoryEntry = z
  .object({
    id: z.string().min(1),
    kind: MemoryKind,
    scope: MemoryScope.default("agent"),
    title: z.string().optional(),
    content: z.string(),
    date: z.string().optional(),
    tags: z.array(z.string()).default([]),
    source: Provenance.optional()
  })
  .passthrough();
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const EmbeddedFile = z
  .object({
    path: z.string().min(1),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    content: z.string(),
    mediaType: z.string().optional(),
    executable: z.boolean().default(false)
  })
  .passthrough();
export type EmbeddedFile = z.infer<typeof EmbeddedFile>;

export const Skill = z
  .object({
    name: z.string().min(1),
    description: z.string().default(""),
    instructions: z.string().default(""),
    version: z.string().optional(),
    author: z.string().optional(),
    dependencies: z.array(z.string()).default([]),
    platforms: z.array(z.string()).default([]),
    allowedTools: z.array(z.string()).default([]),
    installation: z.string().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    references: z.array(z.string()).default([]),
    files: z.array(EmbeddedFile).default([]),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
    invocation: z.enum(["auto", "manual"]).default("auto"),
    source: Provenance.optional()
  })
  .passthrough();
export type Skill = z.infer<typeof Skill>;

/** A value that may be a secret. Secret values are stripped by default and kept as references. */
export const EnvValue = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ secretRef: z.string(), redacted: z.literal(true) }).strict()
]);
export type EnvValue = z.infer<typeof EnvValue>;

export const McpServer = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().optional(),
    env: z.record(z.string(), EnvValue).default({}),
    headers: z.record(z.string(), EnvValue).default({}),
    cwd: z.string().optional()
  })
  .passthrough();
export type McpServer = z.infer<typeof McpServer>;

export const Tool = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(["mcp", "builtin", "function"]),
    mcp: McpServer.optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    output: z.string().optional(),
    auth: z
      .object({
        required: z.boolean().default(false),
        kind: z.string().optional(),
        envVars: z.array(z.string()).default([])
      })
      .optional(),
    permissions: z.array(z.string()).default([]),
    platforms: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    source: Provenance.optional()
  })
  .passthrough();
export type Tool = z.infer<typeof Tool>;

export const Integration = z
  .object({
    name: z.string().min(1),
    kind: z.string(),
    description: z.string().optional(),
    requiresAuth: z.boolean().default(false),
    config: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().optional(),
    source: Provenance.optional()
  })
  .passthrough();
export type Integration = z.infer<typeof Integration>;

export const WorkflowTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expr: z.string() }),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
  z.object({ kind: z.literal("once"), at: z.string() }),
  z.object({ kind: z.literal("event"), event: z.string() }),
  z.object({ kind: z.literal("manual") })
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const WorkflowAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string() }),
  z.object({ kind: z.literal("skill"), name: z.string() }),
  z.object({ kind: z.literal("script"), path: z.string() })
]);
export type WorkflowAction = z.infer<typeof WorkflowAction>;

export const Workflow = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: WorkflowTrigger,
    timezone: z.string().optional(),
    actions: z.array(WorkflowAction).min(1),
    requiredTools: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
    conditions: z.array(z.string()).default([]),
    delivery: z.string().optional(),
    /** Whether the workflow was active on the source platform. */
    sourceEnabled: z.boolean().default(false),
    /** Whether the workflow is active in this document. Imports always set this to false. */
    enabled: z.boolean().default(false),
    source: Provenance.optional()
  })
  .passthrough();
export type Workflow = z.infer<typeof Workflow>;

export const Capability = z.enum([
  "read",
  "write",
  "file",
  "shell",
  "network",
  "browser",
  "computer",
  "schedule",
  "tool",
  "integration"
]);
export type Capability = z.infer<typeof Capability>;

export const RuleEffect = z.enum(["allow", "ask", "deny"]);
export type RuleEffect = z.infer<typeof RuleEffect>;

export const PermissionRule = z
  .object({
    capability: Capability,
    effect: RuleEffect,
    pattern: z.string().optional(),
    source: z.string().optional().describe("The native rule this was derived from")
  })
  .passthrough();
export type PermissionRule = z.infer<typeof PermissionRule>;

export const PolicyMode = z.enum(["ask", "auto", "read-only"]);
export type PolicyMode = z.infer<typeof PolicyMode>;

export const PermissionPolicy = z
  .object({
    mode: PolicyMode.default("ask"),
    rules: z.array(PermissionRule).default([]),
    notes: z.array(z.string()).default([])
  })
  .passthrough();
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const KnowledgeRef = z
  .object({
    path: z.string(),
    title: z.string().optional(),
    mediaType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().optional()
  })
  .passthrough();
export type KnowledgeRef = z.infer<typeof KnowledgeRef>;

export const SourceInfo = z
  .object({
    platform: z.string(),
    adapterVersion: z.string().optional(),
    platformVersion: z.string().optional(),
    nativeId: z.string().optional(),
    location: z.string().optional(),
    readAt: z.string().optional()
  })
  .passthrough();
export type SourceInfo = z.infer<typeof SourceInfo>;

export const MigrationHistoryEntry = z
  .object({
    operationId: z.string(),
    kind: z.enum(["export", "import", "migrate", "restore", "sync", "duplicate"]),
    from: z.string().optional(),
    to: z.string().optional(),
    at: z.string(),
    note: z.string().optional()
  })
  .passthrough();
export type MigrationHistoryEntry = z.infer<typeof MigrationHistoryEntry>;

export const AgentDocument = z
  .object({
    schemaVersion: z.enum(SUPPORTED_SCHEMA_VERSIONS),
    id: AgentId,
    name: z.string().min(1),
    description: z.string().optional(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
    packageVersion: z.number().int().positive().default(1),
    source: SourceInfo,
    identity: Identity,
    models: ModelPreferences.default({ fallbacks: [] }),
    instructions: z.array(Instruction).default([]),
    memory: z.array(MemoryEntry).default([]),
    skills: z.array(Skill).default([]),
    tools: z.array(Tool).default([]),
    integrations: z.array(Integration).default([]),
    workflows: z.array(Workflow).default([]),
    permissions: PermissionPolicy.default({ mode: "ask", rules: [], notes: [] }),
    knowledge: z.array(KnowledgeRef).default([]),
    files: z.array(EmbeddedFile).default([]),
    history: z.array(MigrationHistoryEntry).default([]),
    extensions: Extensions
  })
  .passthrough();
export type AgentDocument = z.infer<typeof AgentDocument>;
export type AgentDocumentInput = z.input<typeof AgentDocument>;

/** Component categories used across compatibility, planning and reporting. */
export const ComponentCategory = z.enum([
  "identity",
  "instructions",
  "memory",
  "skills",
  "tools",
  "integrations",
  "models",
  "permissions",
  "workflows",
  "knowledge",
  "project"
]);
export type ComponentCategory = z.infer<typeof ComponentCategory>;
export const COMPONENT_CATEGORIES = ComponentCategory.options;
