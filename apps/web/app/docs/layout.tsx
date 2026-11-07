import { SiteFooter } from "@/components/SiteFooter";
import { DocNav } from "./DocNav";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="wrap doc-layout">
        <DocNav />
        <main id="main" className="prose">
          {children}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
