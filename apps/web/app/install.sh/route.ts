import { installScript } from "@/lib/install-script";

// Mac and Linux installer: curl -fsSL https://thenomad.website/install.sh | sh
export const dynamic = "force-static";

export function GET() {
  return installScript("install.sh");
}
