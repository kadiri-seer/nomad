import type { NextConfig } from "next";

// NOMAD_EXPORT=1 builds the whole site as static files for `nomad ui` to serve
// from the npm package. Route handlers (*.ts) are left out; the CLI answers
// the same API itself.
const exporting = process.env.NOMAD_EXPORT === "1";

const config: NextConfig = {
  transpilePackages: ["@nomad/adapters", "@nomad/archive", "@nomad/compatibility", "@nomad/core", "@nomad/migration", "@nomad/schema", "@nomad/security", "@nomad/storage"],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  ...(exporting ? { output: "export" as const, pageExtensions: ["tsx"], distDir: ".next-export" } : {}),
  reactStrictMode: true,
  async headers() {
    if (exporting) return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  }
};

export default config;
