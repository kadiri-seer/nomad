import type { Metadata } from "next";
import { AccountApp } from "@/components/account/AccountApp";

export const metadata: Metadata = {
  title: "Your Nomad account",
  description: "Sign in with Google, create agents with $NOMAD and let them run on their own."
};

export default function AccountPage() {
  return <AccountApp />;
}
