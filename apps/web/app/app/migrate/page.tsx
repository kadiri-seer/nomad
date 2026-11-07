"use client";

import { Suspense } from "react";
import { MigrationWizard } from "@/components/MigrationWizard";
import { PageHead, Skeleton } from "@/components/ui";

export default function MigratePage() {
  return (
    <>
      <PageHead title="Migrate an agent" sub="Nothing changes until you approve the preview. Every run is backed up and can be undone." />
      <Suspense fallback={<Skeleton rows={6} />}>
        <MigrationWizard />
      </Suspense>
    </>
  );
}
