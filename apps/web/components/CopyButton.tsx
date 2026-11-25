"use client";

/** A copy button that says "Copied" for a moment, so it is clear the copy worked. */
import { useState } from "react";

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label}
    </button>
  );
}
