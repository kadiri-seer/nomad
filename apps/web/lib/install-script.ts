import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The one-line installers live in scripts/install so the release workflow tests the exact files
 * the site serves. They are read once, when the site is built.
 */
export function installScript(name: "install.ps1" | "install.sh"): Response {
  const candidates = [join(process.cwd(), "../../scripts/install", name), join(process.cwd(), "scripts/install", name)];
  let text: string | undefined;
  for (const p of candidates) {
    try {
      text = readFileSync(/*turbopackIgnore: true*/ p, "utf8");
      break;
    } catch {
      /* try the next location */
    }
  }
  if (text === undefined) throw new Error(`scripts/install/${name} was not found when building the site.`);
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Disposition": `inline; filename="${name}"`
    }
  });
}
