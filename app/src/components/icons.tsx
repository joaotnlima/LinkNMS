// Semantic icon set. The four-pillar `icon` token (design §5) maps here so the
// RAG signal survives with colour stripped out (FR9). All icons are stroke-only
// so they inherit `currentColor` / the pillar's stroke override.
import type { IconName, PillarKey } from '@/lib/types';

type P = { className?: string };

export function StatusIcon({ name, className }: { name: IconName; className?: string }) {
  switch (name) {
    case 'check-circle':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5l2.5 2.5L16 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'info':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
        </svg>
      );
    case 'alert-triangle':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3l9 16H3z" strokeLinejoin="round" />
          <path d="M12 9v4M12 16h.01" strokeLinecap="round" />
        </svg>
      );
    case 'alert-octagon':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" strokeLinejoin="round" />
          <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
        </svg>
      );
    case 'shield':
      // SAFETY's "not tracked yet" glyph — a plain shield, NOT a shield-check:
      // the check would read as "verified safe", which is the claim ADR-0015 §2
      // refuses to make with no data behind it.
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" strokeLinejoin="round" />
        </svg>
      );
  }
}

// The M14 pillar identity glyphs (ADR-0015 §1). They mirror the pen's lucide
// icons: calendar-range, wallet, file-diff, shield.
export function PillarGlyph({ pillar, className }: { pillar: PillarKey; className?: string }) {
  switch (pillar) {
    case 'schedule':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
          <path d="M4 9h16M8 3v4M16 3v4" strokeLinecap="round" />
        </svg>
      );
    case 'budget':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M4 7a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
          <path d="M16 11h3v3h-3a1.5 1.5 0 0 1 0-3z" strokeLinejoin="round" />
        </svg>
      );
    case 'scope':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" strokeLinejoin="round" />
          <path d="M14 3v5h5M9 13h2m-1-1v2M9 17h4" strokeLinecap="round" />
        </svg>
      );
    case 'safety':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" strokeLinejoin="round" />
        </svg>
      );
  }
}

export const Mark = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden>
    <path d="M4 11L12 4l8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 21v-6h6v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);

export const HomeIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M3 11l9-7 9 7M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const DecisionIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z" strokeLinejoin="round" /><path d="M8 10h8M8 14h6" strokeLinecap="round" /></svg>
);
export const ChangeIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 7h13l-3-3M20 17H7l3 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const AuditIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 19V9m5 10V5m5 14v-7m5 7V8" strokeLinecap="round" /></svg>
);
// ── M14 bottom-nav icons (ADR-0015 §6): Builds · Plan · Docs · More ──────────
export const BuildsIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z" strokeLinejoin="round" /></svg>
);
export const PlanIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" /><path d="M4 9h16M8 3v4M16 3v4" strokeLinecap="round" /></svg>
);
export const DocsIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" strokeLinejoin="round" /></svg>
);
export const MoreIcon = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M5 12h.01M12 12h.01M19 12h.01" strokeLinecap="round" strokeWidth="2.6" /></svg>
);
export const ShieldCheck = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Check = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const PencilEdit = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" /></svg>
);
