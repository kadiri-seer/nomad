import {
  AgentDocument,
  type AgentDocumentInput,
  type ComponentCategory,
  UAF_SCHEMA_VERSION,
  parseDocument
} from "@nomad/schema";
import { canonicalJson, sha256 } from "./hash";
import { ulid } from "./ids";

export function createDocument(input: {
  name: string;
  platform: string;
  id?: string;
  description?: string;
  now?: Date;
}): AgentDocument {
  const now = (input.now ?? new Date()).toISOString();
  const raw: AgentDocumentInput = {
    schemaVersion: UAF_SCHEMA_VERSION,
    id: input.id ?? ulid(),
    name: input.name,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    source: { platform: input.platform, readAt: now },
    identity: { name: input.name, description: input.description }
  };
  return parseDocument(raw);
}

/** Fields that change on every read and must not affect change detection. */
function stripVolatile(doc: AgentDocument): unknown {
  const { updatedAt: _u, createdAt: _c, history: _h, source, packageVersion: _p, ...rest } = doc;
  const { readAt: _r, location: _l, ...src } = source;
  return { ...rest, source: { platform: src.platform } };
}

/** Content hash of a document. Equal hashes mean equal agent content. */
export function documentHash(doc: AgentDocument): string {
  return sha256(canonicalJson(stripVolatile(doc)));
}

export function componentHash(doc: AgentDocument, category: ComponentCategory): string {
  return sha256(canonicalJson(selectComponent(doc, category)));
}

export function selectComponent(doc: AgentDocument, category: ComponentCategory): unknown {
  switch (category) {
    case "identity":
      return doc.identity;
    case "instructions":
      return doc.instructions;
    case "memory":
      return doc.memory;
    case "skills":
      return doc.skills;
    case "tools":
      return doc.tools;
    case "integrations":
      return doc.integrations;
    case "models":
      return doc.models;
    case "permissions":
      return doc.permissions;
    case "workflows":
      return doc.workflows;
    case "knowledge":
      return { knowledge: doc.knowledge, files: doc.files };
    case "project":
      return doc.extensions;
  }
}

/** Number of items a document has in a category. Zero means not applicable. */
export function componentCount(doc: AgentDocument, category: ComponentCategory): number {
  switch (category) {
    case "identity":
      return doc.identity.persona || doc.identity.description || doc.identity.tone ? 1 : doc.identity.name ? 1 : 0;
    case "instructions":
      return doc.instructions.filter((i) => i.content.trim()).length;
    case "memory":
      return doc.memory.length;
    case "skills":
      return doc.skills.length;
    case "tools":
      return doc.tools.length;
    case "integrations":
      return doc.integrations.length;
    case "models":
      return doc.models.preferred || doc.models.fallbacks.length ? 1 : 0;
    case "permissions":
      return doc.permissions.rules.length + (doc.permissions.mode !== "ask" ? 1 : 0);
    case "workflows":
      return doc.workflows.length;
    case "knowledge":
      return doc.knowledge.length + doc.files.length;
    case "project":
      return Object.keys(doc.extensions).length;
  }
}

/** Keep only the selected component categories. Identity and models always travel. */
export function filterComponents(doc: AgentDocument, components: ComponentCategory[]): AgentDocument {
  const keep = new Set(components);
  return {
    ...doc,
    instructions: keep.has("instructions") ? doc.instructions : [],
    memory: keep.has("memory") ? doc.memory : [],
    skills: keep.has("skills") ? doc.skills : [],
    tools: keep.has("tools") ? doc.tools : [],
    integrations: keep.has("integrations") ? doc.integrations : [],
    workflows: keep.has("workflows") ? doc.workflows : [],
    permissions: keep.has("permissions") ? doc.permissions : { mode: "ask", rules: [], notes: [] },
    knowledge: keep.has("knowledge") ? doc.knowledge : [],
    files: keep.has("knowledge") ? doc.files : [],
    extensions: keep.has("project") ? doc.extensions : {}
  };
}

/** Imported workflows are never active. */
export function disableWorkflows(doc: AgentDocument): AgentDocument {
  return { ...doc, workflows: doc.workflows.map((w) => ({ ...w, enabled: false })) };
}

/** A copy of the agent with a new portable identity. */
export function duplicateDocument(doc: AgentDocument, name?: string): AgentDocument {
  const now = new Date().toISOString();
  const newName = name ?? `${doc.name} (copy)`;
  return AgentDocument.parse({
    ...doc,
    id: ulid(),
    name: newName,
    identity: { ...doc.identity, name: newName },
    createdAt: now,
    updatedAt: now,
    history: [],
    extensions: { ...doc.extensions, "x-nomad": { duplicatedFrom: doc.id } }
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
