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
  }
}

export function PillarGlyph({ pillar, className }: { pillar: PillarKey; className?: string }) {
  switch (pillar) {
    case 'scope':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
        </svg>
      );
    case 'time':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" strokeLinecap="round" />
        </svg>
      );
    case 'cost':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3v18M8 7h6a2.5 2.5 0 0 1 0 5H9a2.5 2.5 0 0 0 0 5h7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'quality':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 15.9 6.8 18l1.2-5.6L3.8 8.6 9.4 8z" strokeLinejoin="round" />
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
export const ShieldCheck = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Check = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const PencilEdit = (p: P) => (
  <svg {...p} viewBox="0 0 24 24"><path d="M4 20h4L18 10l-4-4L4 16z" strokeLinejoin="round" /></svg>
);
