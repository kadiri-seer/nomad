export const X_URL = "https://x.com/thenomadlabs";
export const X_HANDLE = "@thenomadlabs";

/** The X logo, drawn in the current text colour. */
export function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** A link to Nomad on X: the logo alone, named for screen readers. */
export function XLink({ className, size = 18 }: { className?: string; size?: number }) {
  return (
    <a href={X_URL} target="_blank" rel="me noopener noreferrer" className={className} aria-label={`Nomad on X (${X_HANDLE})`} title={`Nomad on X (${X_HANDLE})`} style={{ display: "inline-flex", alignItems: "center" }}>
      <XIcon size={size} />
    </a>
  );
}
