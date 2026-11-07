import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "96px 20px 120px" }}>
        <p className="label">Error 404</p>
        <h1 style={{ marginTop: 14, maxWidth: "16ch" }}>This page wandered off.</h1>
        <p className="lede" style={{ marginTop: 18 }}>The address may be mistyped, or the page moved. Your agents are fine.</p>
        <div className="row" style={{ marginTop: 28 }}>
          <Link href="/" className="btn">Back to the home page</Link>
          <Link href="/docs" className="btn btn-quiet">Read the docs</Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
