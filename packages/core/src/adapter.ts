import type { AgentDocument, ComponentCategory, PermissionPolicy } from "@nomad/schema";

/**
 * The adapter contract. Every platform integration implements this interface.
 * The core engine never contains platform specific conditions: it asks adapters
 * what they support, what files they want to write and how to verify results.
 */

/** Overall honesty label shown in the interface. */
export type SupportLevel = "FULL" | "PARTIAL" | "GUIDED" | "EXPERIMENTAL" | "UNAVAILABLE";

/** Per category support. */
export type CategorySupport = "full" | "convert" | "manual" | "unsupported";

export type PlatformCategory = "coding-agent" | "personal-agent" | "framework" | "hosted" | "generic";

export interface CategoryCapability {
  read: CategorySupport;
  write: CategorySupport;
  notes?: string;
}

export type CapabilityMatrix = Record<ComponentCategory, CategoryCapability>;

export interface AdapterInfo {
  id: string;
  displayName: string;
  category: PlatformCategory;
  support: SupportLevel;
  adapterVersion: string;
  /** Platform versions the adapter was built against, as free text. */
  supportedVersions: string;
  description: string;
  docsUrl?: string;
  /** Default locations, using ~ for the home directory. */
  defaultLocations: string[];
  /** Whether a single location can hold several agents. */
  multiAgent: boolean;
  configFormats: string[];
  capabilities: CapabilityMatrix;
  /** Known limitations shown next to the support status. */
  limitations: string[];
}

export interface DetectResult {
  detected: boolean;
  confidence: number;
  platformVersion?: string;
  evidence: string[];
}

export interface AgentRef {
  nativeId: string;
  name: string;
  description?: string;
  location: string;
  kind: "main" | "subagent" | "profile" | "workspace" | "package";
}

export type NoteLevel = "info" | "warning" | "error";

export interface Note {
  level: NoteLevel;
  category?: ComponentCategory;
  message: string;
  detail?: string;
}

export interface ReadOptions {
  /** Include knowledge and arbitrary files in the document. */
  includeFiles?: boolean;
  /** Keep secret values instead of replacing them with references. */
  includeSecrets?: boolean;
  /** When a file holds several Nomad agents, read this one. */
  agentId?: string;
}

export interface ReadResult {
  doc: AgentDocument;
  /** Absolute paths that were read. Used for backups of the source. */
  sourceFiles: string[];
  notes: Note[];
}

export type WriteStrategy =
  /** Write the whole file. In merge mode an existing different file is kept. */
  | "replace"
  /** Only write when the file does not exist. */
  | "create-only"
  /** Markdown: own a block between nomad markers, leave the rest of the file alone. */
  | "managed-block"
  /** Structured merge of JSON, JSON5, TOML or YAML documents. */
  | "merge-json"
  | "merge-json5"
  | "merge-toml"
  | "merge-yaml"
  /** Delimited entry list (for example Hermes memory files). Union with dedupe. */
  | "append-entries";

export interface DesiredFile {
  /** POSIX path relative to the destination root. */
  path: string;
  content: string | Uint8Array;
  strategy: WriteStrategy;
  component: ComponentCategory;
  description: string;
  /** For managed blocks: block identity. */
  blockKey?: string;
  /** For append-entries: the delimiter between entries. */
  entryDelimiter?: string;
  /** For structured merges: arrays of objects keyed by this field (path pattern -> key). */
  arrayKeys?: Record<string, string>;
  /** File mode for new files. */
  mode?: number;
  /** When true the file belongs entirely to this agent (safe to replace in replace mode). */
  agentOwned?: boolean;
  /**
   * Absolute root for this file when it lives outside the destination root
   * (for example ~/.claude.json next to ~/.claude, or an OpenClaw workspace
   * configured elsewhere). Containment and symlink checks use this root.
   */
  root?: string;
}

export type ConflictMode = "merge" | "copy" | "replace";

export interface WriteContext {
  root: string;
  mode: ConflictMode;
  /** For copy mode: name of the new agent. */
  targetName?: string;
  /** Native id to write into, when updating a known agent. */
  targetNativeId?: string;
  components: ComponentCategory[];
}

export interface Conversion {
  category: ComponentCategory;
  item: string;
  from: string;
  to: string;
  detail?: string;
}

export interface UnsupportedItem {
  category: ComponentCategory;
  item: string;
  reason: string;
  alternative?: string;
}

export interface PlannedWrite {
  nativeId: string;
  files: DesiredFile[];
  notes: Note[];
  manualSteps: string[];
  conversions: Conversion[];
  unsupported: UnsupportedItem[];
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GuidedKit {
  files: Array<{ path: string; content: string }>;
  steps: string[];
}

export interface Adapter {
  info: AdapterInfo;
  detect(root: string): Promise<DetectResult>;
  discover(root: string): Promise<AgentRef[]>;
  read?(root: string, nativeId: string, options?: ReadOptions): Promise<ReadResult>;
  /** Compute the files that represent `doc` in this platform. Pure with respect to the destination. */
  plan?(doc: AgentDocument, ctx: WriteContext): Promise<PlannedWrite>;
  /** Read only the permission policy at a location. Used to detect privilege widening. */
  readPolicy?(root: string, nativeId?: string): Promise<PermissionPolicy | null>;
  /** Check a written agent against the document. */
  verify?(doc: AgentDocument, root: string, nativeId: string, ctx: WriteContext): Promise<VerifyCheck[]>;
  /** For guided platforms: produce files and steps the user follows manually. */
  guidedKit?(doc: AgentDocument): GuidedKit;
}

export const SUPPORT_LABELS: Record<SupportLevel, string> = {
  FULL: "Full",
  PARTIAL: "Partial",
  GUIDED: "Guided",
  EXPERIMENTAL: "Experimental",
  UNAVAILABLE: "Unavailable"
};

export const SUPPORT_DESCRIPTIONS: Record<SupportLevel, string> = {
  FULL: "Direct import and export for the declared capabilities.",
  PARTIAL: "Direct integration exists, but some capabilities require conversion or are unsupported.",
  GUIDED: "Nomad prepares the files and guides you through the remaining manual steps.",
  EXPERIMENTAL: "Integration exists but has limited testing or incomplete compatibility.",
  UNAVAILABLE: "No reliable integration is currently possible."
};

export function capabilityMatrix(
  partial: Partial<CapabilityMatrix>,
  fallback: CategoryCapability = { read: "unsupported", write: "unsupported" }
): CapabilityMatrix {
  const cats: ComponentCategory[] = [
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
  ];
  const out = {} as CapabilityMatrix;
  for (const c of cats) out[c] = partial[c] ?? fallback;
  return out;
}
