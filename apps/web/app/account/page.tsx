import type { Metadata } from "next";
import { AccountFast } from "@/components/account/AccountFast";

export const metadata: Metadata = {
  title: "Your Nomad account",
  description: "Sign in with Google, create agents with $NOMAD and let them run on their own."
};

/** Open once Google sign-in (Privy) and the paymaster are both set on this deployment. */
const enabled = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() && !!process.env.NEXT_PUBLIC_NOMAD_PAYMASTER?.trim();

export default function AccountPage() {
  return <AccountFast enabled={enabled} />;
}
