/** The Nomad mark: a zigzag band, drawn as an outlined ribbon. */
export function Mark({ size = 30, color = "var(--blue)", title }: { size?: number; color?: string; title?: string }) {
  return (
    <svg width={(size * 300) / 190} height={size} viewBox="0 0 300 190" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <g fill="none" stroke={color} strokeWidth="17" strokeLinejoin="miter" strokeMiterlimit="10">
        <path d="M12 120 L100 24 L170 94 L212 57 L266 112 L266 150 L212 108 L170 146 L100 76 L12 168 Z" />
        <path d="M258 146 L290 172" strokeLinecap="square" />
      </g>
    </svg>
  );
}

/** NOMAD wordmark with the open Λ, matching the logo. */
export function Wordmark({ height = 15 }: { height?: number }) {
  return (
    <svg height={height} width={(height * 520) / 112} viewBox="-8 -6 520 112" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="13" strokeLinejoin="miter" strokeLinecap="butt">
        <path d="M6 100 V4 L66 96 V0" />
        <circle cx="140" cy="50" r="44" />
        <path d="M212 100 V4 L251 64 L290 4 V100" />
        <path d="M318 100 L355 2 L392 100" />
        <path d="M428 6 H452 A44 44 0 0 1 452 94 H428 Z" />
      </g>
    </svg>
  );
}

export function Logo({ markSize = 28 }: { markSize?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <Mark size={markSize} />
      <Wordmark height={Math.round(markSize * 0.52)} />
      <span className="visually-hidden">Nomad</span>
    </span>
  );
}
