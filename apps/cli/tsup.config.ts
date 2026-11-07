import { defineConfig } from "tsup";

export default defineConfig({
  entry: { nomad: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Internal workspace packages are bundled; third party packages stay dependencies.
  noExternal: [/^@nomad\//],
  banner: { js: "#!/usr/bin/env node" }
});
