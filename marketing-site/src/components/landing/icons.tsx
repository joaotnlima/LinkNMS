// Inline landing icons. Small enough that a sprite or an icon dependency would
// cost more than it saves, and inline SVG inherits `currentColor` so the header
// rule "content colour never flips" holds without a second code path.

type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: 'false' as const
});

export function GlobeIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 11, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CheckIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 4v15M6 13l6 6 6-6" />
    </svg>
  );
}

export function FileIcon({ size = 17, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function SparkIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v4M12 17v4M4.9 7.5l2.9 2.9M16.2 13.6l2.9 2.9M3 12h4M17 12h4M4.9 16.5l2.9-2.9M16.2 10.4l2.9-2.9" />
    </svg>
  );
}

export function PhoneIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="7" y="2" width="10" height="20" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

export function BrowserIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}

export function DesktopIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}

export function DotIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}

export function DotFilledIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false" className={className}>
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

/**
 * The "row closed" mark of the pinned sequence — lucide `badge-check`, which is
 * the glyph the pen's `new-key-frames` frame names on every closed row. Drawn
 * inline for the same reason as the rest of this file rather than pulling in an
 * icon dependency for one 12px mark.
 */
export function BadgeCheckIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * The landing lockup mark. The product HouseMark is drawn in the app's
 * `--primary` / `--secondary`; on the landing surface the roof reads in the
 * plan semantics (baseline / actual) over an ink or cream ground.
 */
export function LandingMark({ size = 22, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false" className={className}>
      <rect x="12" y="26" width="40" height="30" rx="2" fill="currentColor" opacity="0.14" />
      <rect x="12" y="26" width="40" height="30" rx="2" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M32 6 8 26h24z" fill="var(--plan-baseline)" />
      <path d="M32 6l24 20H32z" fill="var(--plan-actual)" />
      <rect x="18" y="34" width="28" height="6" rx="3" fill="var(--plan-baseline)" />
      <rect x="18" y="44" width="17" height="6" rx="3" fill="var(--plan-closed)" />
    </svg>
  );
}
