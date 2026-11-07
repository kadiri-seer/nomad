import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

/** Parse a Markdown file with optional YAML frontmatter. Malformed frontmatter is treated as body. */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (!m) return { data: {}, body: normalized, hasFrontmatter: false };
  try {
    const data = parseYaml(m[1]);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: normalized.slice(m[0].length), hasFrontmatter: true };
    }
  } catch {
    /* fall through */
  }
  return { data: {}, body: normalized, hasFrontmatter: false };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return ensureTrailingNewline(body);
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${ensureTrailingNewline(body.replace(/^\n+/, ""))}`;
}

export function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

const BLOCK_RE = (key: string) =>
  new RegExp(`<!-- nomad:begin ${escapeRe(key)}(?: [^>]*)? -->\\r?\\n?([\\s\\S]*?)\\r?\\n?<!-- nomad:end ${escapeRe(key)} -->`);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function blockMarkers(key: string, meta?: string) {
  return {
    begin: `<!-- nomad:begin ${key}${meta ? " " + meta : ""} -->`,
    end: `<!-- nomad:end ${key} -->`
  };
}

/** Wrap content in nomad managed block markers. */
export function wrapBlock(key: string, content: string, meta?: string): string {
  const { begin, end } = blockMarkers(key, meta);
  return `${begin}\n${content.trim()}\n${end}`;
}

export function extractBlock(text: string, key: string): string | null {
  const m = BLOCK_RE(key).exec(text);
  return m ? m[1] : null;
}

/** Insert or replace a managed block. The rest of the file is left untouched. */
export function upsertBlock(text: string, key: string, content: string, meta?: string): string {
  const block = wrapBlock(key, content, meta);
  const re = BLOCK_RE(key);
  if (re.test(text)) return text.replace(re, () => block);
  const base = text.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function removeBlocks(text: string): string {
  return text.replace(/<!-- nomad:begin [^>]* -->[\s\S]*?<!-- nomad:end [^>]* -->\n?/g, "").trimEnd() + "\n";
}

/** Nomad agent identity marker. Lets a later read recover the portable id. */
export function findAgentIdMarker(text: string): string | null {
  const m = /<!-- nomad:(?:begin )?agent=([0-9A-HJKMNP-TV-Z]{26})/.exec(text);
  return m ? m[1] : null;
}

/** Split markdown into level-2 sections. Content before the first heading has title null. */
export function splitSections(text: string): Array<{ title: string | null; body: string }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ title: string | null; body: string[] }> = [{ title: null, body: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ title: m[1], body: [] });
    else out[out.length - 1].body.push(line);
  }
  return out
    .map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
    .filter((s) => s.title !== null || s.body.length > 0);
}

/** Extract `- item` bullets from markdown. Multi-line bullets are joined. */
export function bulletItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (m) items.push(m[1].trim());
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += " " + line.trim();
  }
  return items.filter(Boolean);
}

export function firstHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : null;
}
