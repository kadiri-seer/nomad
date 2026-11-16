import { installScript } from "@/lib/install-script";

// Windows installer: irm https://www.thenomad.website/install.ps1 | iex
export const dynamic = "force-static";

export function GET() {
  return installScript("install.ps1");
}
