#!/usr/bin/env node
// Builds a clean folder for publishing the CLI to npm: release/npm
// Usage: node scripts/prepare-npm.mjs [package-name]   (default: thenomad)
// Then:  cd release/npm && npm publish --access public
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] ?? "thenomad";
const cli = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8"));
const out = join(root, "release/npm");

execSync("pnpm --filter @nomad/cli build", { cwd: root, stdio: "inherit" });
// The dashboard ships as static files that `nomad ui` serves itself.
execSync("pnpm --filter @nomad/web build:export", { cwd: root, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });
cpSync(join(root, "apps/cli/dist/nomad.js"), join(out, "dist/nomad.js"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
cpSync(join(root, "apps/web/.next-export"), join(out, "web"), { recursive: true });

// Workspace packages are bundled into dist/nomad.js, so only third-party packages stay.
const dependencies = Object.fromEntries(Object.entries(cli.dependencies).filter(([dep]) => !dep.startsWith("@nomad/")));

const pkg = {
  name,
  version: cli.version,
  description: "Move AI agents between OpenClaw, Claude Code, Codex, Hermes and more, with a preview, a backup and one question.",
  keywords: ["ai", "agents", "migration", "openclaw", "claude-code", "codex", "hermes", "mcp", "portability"],
  homepage: "https://github.com/kadiri-seer/nomad",
  repository: { type: "git", url: "git+https://github.com/kadiri-seer/nomad.git" },
  bugs: "https://github.com/kadiri-seer/nomad/issues",
  author: "kadiri-seer (https://github.com/kadiri-seer)",
  license: cli.license,
  type: "module",
  // "nomad" after a global install; the package name too, so npx always finds it.
  bin: { nomad: "dist/nomad.js", ...(name !== "nomad" ? { [name]: "dist/nomad.js" } : {}) },
  files: ["dist", "web", "LICENSE", "README.md"],
  engines: cli.engines,
  dependencies
};
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

writeFileSync(
  join(out, "README.md"),
  `# Nomad

Move AI agents between platforms without losing who they are: identity, instructions, memory, skills, tools, routines and permissions.

\`\`\`
npx ${name}
\`\`\`

That finds the agents on your computer, asks which one and where it should go, shows a short summary and asks once. A backup is taken before anything is written.

\`\`\`
npx ${name} move openclaw codex          one line, same summary and question
npx ${name} move openclaw ./kestrel.nomad save to a file you can share or keep
npx ${name} move ./kestrel.nomad hermes   open that file somewhere else
npx ${name} restore <backup-id>          undo
npx ${name} ui                           the dashboard, in your browser
\`\`\`

Install it to type \`nomad\` instead: \`npm install -g ${name}\`. Requires Node.js ${cli.engines.node.replace(">=", "")} or newer.

Everything runs on your machine. There is no account and nothing is uploaded. Documentation and source: https://github.com/kadiri-seer/nomad
`
);

console.log(`\nReady in release/npm as "${name}" ${cli.version}.\nNext: cd release/npm && npm publish --access public`);
