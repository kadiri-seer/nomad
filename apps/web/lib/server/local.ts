import type { Nomad } from "@nomad/migration";

/**
 * Used only by `nomad ui --dev`, which runs this Next.js app with the token in
 * the environment. The normal `nomad ui` serves the exported pages and the same
 * API from the CLI itself.
 */
export async function localContext(): Promise<{ token: string; port: string } | null> {
  const token = process.env.NOMAD_LOCAL_TOKEN;
  if (process.env.NOMAD_LOCAL !== "1" || !token || token.length < 16) return null;
  return { token, port: process.env.PORT ?? "4317" };
}

const g = globalThis as unknown as { __nomad?: Nomad };

export async function engine(): Promise<Nomad> {
  if (!g.__nomad) {
    const { Nomad } = await import("@nomad/migration");
    g.__nomad = new Nomad({ home: process.env.NOMAD_HOME });
  }
  return g.__nomad;
}
