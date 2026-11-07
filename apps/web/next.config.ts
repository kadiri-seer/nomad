import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@nomad/adapters", "@nomad/archive", "@nomad/compatibility", "@nomad/core", "@nomad/migration", "@nomad/schema", "@nomad/security", "@nomad/storage"],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
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
