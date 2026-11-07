// Static export for `nomad ui`. A script instead of `NOMAD_EXPORT=1 next build` so it also works in Windows shells.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const r = spawnSync(process.execPath, [next, "build"], { stdio: "inherit", env: { ...process.env, NOMAD_EXPORT: "1" } });
process.exit(r.status ?? 1);
