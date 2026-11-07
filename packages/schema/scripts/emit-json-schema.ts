import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemas } from "../src/index";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "json");
mkdirSync(out, { recursive: true });
const s = jsonSchemas();
writeFileSync(join(out, "agent-document.schema.json"), JSON.stringify(s.agentDocument, null, 2) + "\n");
writeFileSync(join(out, "package-manifest.schema.json"), JSON.stringify(s.packageManifest, null, 2) + "\n");
console.log("Wrote JSON Schema files to", out);
