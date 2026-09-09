// App chrome: the top bar (brand + integrity health dot) and the bottom nav that
// ties the build's surfaces together. Mobile-first; the shell caps width for
// desktop. The bottom nav is the pen M14 tab bar (ADR-0015 §6).
import Link from 'next/link';
import {
  Mark, BuildsIcon, PlanIcon, DocsIcon, MoreIcon, DecisionIcon, ChangeIcon, AuditIcon,
} from './icons';

export function TopBar({ back }: { back?: { href: string; label: string } }) {
  return (
    <header className="topbar">
      {back ? (
        <Link className="back" href={back.href}>
          ‹ {back.label}
        </Link>
      ) : (
        <span className="brand">
          <Mark className="mk" />
          LinkNMS
        </span>
      )}
      <span className="health" title="Ledger integrity signal">
        <span className="dot" />
        integrity ok
      </span>
    </header>
  );
}

// The M14 tab bar: Builds · Plan · Docs · More (ADR-0015 §6). This is shared
// chrome on every /projects/[id]/* page, so it lives in one place.
//
//  - Builds → the portfolio (/projects).
//  - Plan   → the build's record home (/projects/[id]) — the M14 screen. It is
//             the active tab on every build-scoped page, matching the pen.
//  - Docs   → DIMMED and unlinked: there is no documents surface yet. The pen
//             itself dims build-scoped tabs before a plan exists (M1); a tab that
//             404s is worse than one that visibly is not ready.
//  - More   → overflow to the surfaces that lost their own tab: Decisions,
//             Change orders, Audit, and the full four-tab record. A native
//             <details> popover so the whole nav stays a server component.
type Tab = 'builds' | 'plan' | 'docs' | 'more';

export function BottomNav({ projectId, active = 'plan' }: { projectId: string; active?: Tab }) {
  const base = `/projects/${projectId}`;
  return (
    <nav className="botnav" aria-label="Primary">
      <Link
        href="/projects"
        className={active === 'builds' ? 'active' : undefined}
        aria-current={active === 'builds' ? 'page' : undefined}
      >
        <BuildsIcon />
        Builds
      </Link>
      <Link
        href={base}
        className={active === 'plan' ? 'active' : undefined}
        aria-current={active === 'plan' ? 'page' : undefined}
      >
        <PlanIcon />
        Plan
      </Link>
      {/* Not a link — no documents surface exists yet (ADR-0015 §6). Rendered as
          a disabled control so it reads as "not ready", not "broken". */}
      <span className="botnav-disabled" aria-disabled="true" title="No documents surface yet">
        <DocsIcon />
        Docs
      </span>
      <details className="botnav-more">
        <summary aria-label="More surfaces">
          <MoreIcon />
          More
        </summary>
        <div className="botnav-menu" role="menu">
          <Link role="menuitem" href={`${base}/record`}>
            <PlanIcon /> The record
          </Link>
          <Link role="menuitem" href={`${base}/decisions`}>
            <DecisionIcon /> Decisions
          </Link>
          <Link role="menuitem" href={`${base}/change-orders`}>
            <ChangeIcon /> Change orders
          </Link>
          <Link role="menuitem" href={`${base}/audit`}>
            <AuditIcon /> Audit trail
          </Link>
        </div>
      </details>
    </nav>
  );
}

// `DemoBanner` is GONE (LINA-57), and deliberately not replaced by a quieter
// variant. The surfaces now render persisted data or fail loudly; there is no
// third state left for a banner to warn about, and keeping a dormant one would
// re-open the door to shipping fixtures behind a notice nobody reads.
