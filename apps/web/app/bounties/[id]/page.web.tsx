import { notFound } from "next/navigation";
import { BountyView } from "@/components/BountyView";
import { bountyEnv } from "@/lib/server/bounty-env";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const env = bountyEnv();
  if (!env || !/^[a-z0-9-]{1,60}$/.test(id)) return null;
  return env.publicOne(id).catch(() => null);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const b = await load((await params).id);
  return b ? { title: `${b.title} | Bounty`, description: b.brief.slice(0, 160) } : { title: "Bounty" };
}

export default async function BountyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await load(id);
  if (!b) notFound();
  return <BountyView b={b} />;
}
