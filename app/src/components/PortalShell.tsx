// PortalShell — the portal app chrome (LINA-216, extended LINA-219).
//
// Desktop: a 260px left rail (brand, build switcher, the Portfolio nav, the
// build-scoped nav, and a user footer) beside a top bar + body. Mobile: an app
// bar + body + a four-tab bottom bar. This is the frame the pen draws around
// BOTH the portfolio and the build record — same rail, two states.
//
// ── TWO MODES ────────────────────────────────────────────────────────────────
// PORTFOLIO mode (no `activeBuild`): the empty/returning portfolio. The switcher
// shows a build count and the "THIS BUILD" nav is dimmed — there is no selected
// build to point it at, so it renders present-but-inert, exactly as the pen
// draws the empty state ("chrome, no dead links").
//
// BUILD mode (`activeBuild` set): a build is open. The switcher becomes a live
// dropdown to CHOOSE among your builds, the "THIS BUILD" nav goes live with the
// current `section` highlighted, and the top bar reads a "build › section"
// breadcrumb with a "Log a change" action. This is screenshot 2 in the founder's
// LINA-219 report: selecting a build lands you in this rail, not a bare page.
//
// FULL-BLEED. This is a child of globals.css `.shell` (a 780px reading column,
// right for the record and wrong for a portfolio app). portal-shell.css widens
// the shell only when its child IS this component — the same `:has()` escape
// AuthShell uses (see auth-shell.css).
import Link from 'next/link';

import { AccountMenu } from './AccountMenu';
import './portal-shell.css';

const NEW_BUILD_HREF = '/projects/new';

export type PortalUser = { displayName: string; roleLabel: string };
// `href` is where selecting this build in the switcher goes — its record home
// for a live build, or its wizard step for a draft. Defaults to the record home.
export type BuildRef = { id: string; name: string; href?: string };

// The build-scoped nav sections, in rail order. `section` selects which is
// highlighted in BUILD mode; PORTFOLIO mode passes none.
export type BuildSection = 'overview' | 'plan' | 'schedule' | 'money' | 'history' | 'documents';

// Section → the route it opens, relative to the build. `documents` has no
// surface yet (kept dimmed, never a link — a tab that 404s is worse than one
// that visibly is not ready). Sub-items live under Plan in the rail.
function sectionHref(buildId: string, s: BuildSection): string | null {
  switch (s) {
    case 'overview':
      return `/projects/${buildId}`;
    case 'plan':
      return `/projects/${buildId}/plan`;
    case 'schedule':
      return `/projects/${buildId}/record`;
    case 'money':
      return `/projects/${buildId}/budget`;
    case 'history':
      return `/projects/${buildId}/audit`;
    case 'documents':
      return null;
  }
}

const SECTION_LABEL: Record<BuildSection, string> = {
  overview: 'Overview',
  plan: 'Plan',
  schedule: 'Schedule',
  money: 'Money',
  history: 'History',
  documents: 'Documents',
};

export function PortalShell({
  user,
  children,
  // PORTFOLIO mode only: the switcher's inert label ("No builds yet" / "N builds").
  switcherLabel = 'No builds yet',
  // How the body lays its child out. The empty state is a centred column;
  // `start` top-aligns and stretches for a scrolling list (the portfolio) and
  // for the record body (which owns its own internal spacing).
  align = 'center',
  // BUILD mode: the open build. When set, the shell goes build-scoped — live
  // switcher, live "THIS BUILD" nav, breadcrumb top bar.
  activeBuild,
  // BUILD mode: every build the user can switch to (drives the switcher dropdown).
  builds = [],
  // BUILD mode: which section is showing (highlighted in the rail + tabs).
  section,
  // BUILD mode: overrides the breadcrumb leaf label for build-scoped surfaces
  // that are NOT a rail section — the overflow ones reached via "Log a change"
  // (change orders, decisions). With no `section`, nothing in the rail
  // highlights, and the top bar reads "build › {crumb}" instead of "› Overview".
  crumb,
}: {
  user: PortalUser;
  children: React.ReactNode;
  switcherLabel?: string;
  align?: 'center' | 'start';
  activeBuild?: BuildRef;
  builds?: BuildRef[];
  section?: BuildSection;
  crumb?: string;
}) {
  const buildScoped = activeBuild != null;
  const bid = activeBuild?.id;

  return (
    <div className={`psh${align === 'start' ? ' psh--list' : ''}`}>
      {/* ── Left rail (desktop) ─────────────────────────────────────────── */}
      <aside className="psh-rail" aria-label="Portal">
        <div className="psh-brand">
          <HouseMark />
          <span>LinkNMS</span>
        </div>

        {buildScoped ? (
          <BuildSwitcher active={activeBuild!} builds={builds} />
        ) : (
          <div className="psh-switch" aria-disabled="true">
            <span className="psh-switch-col">
              <span className="psh-switch-kicker">BUILD</span>
              <span className="psh-switch-val">{switcherLabel}</span>
            </span>
            <ChevronsUpDown />
          </div>
        )}

        <nav className="psh-nav" aria-label="Portal sections">
          {/* Portfolio: the active item in portfolio mode, a plain link back
              from a build. */}
          {buildScoped ? (
            <Link className="psh-nav-item" href="/">
              <GridIcon />
              Portfolio
            </Link>
          ) : (
            <span className="psh-nav-item is-active" aria-current="page">
              <GridIcon />
              Portfolio
            </span>
          )}

          <span className="psh-nav-group">This build</span>

          {buildScoped ? (
            <BuildNav buildId={bid!} section={section} />
          ) : (
            <>
              <span className="psh-nav-item is-dim">
                <HouseIcon />
                Overview
              </span>
              <span className="psh-nav-item is-dim">
                <CalendarIcon />
                Plan
                <ChevronRight className="psh-nav-caret" />
              </span>
              <span className="psh-nav-item is-dim is-sub">Schedule</span>
              <span className="psh-nav-item is-dim is-sub">Money</span>
              <span className="psh-nav-item is-dim is-sub">History</span>
              <span className="psh-nav-item is-dim">
                <FolderIcon />
                Documents
              </span>
            </>
          )}
        </nav>

        <AccountMenu displayName={user.displayName} roleLabel={user.roleLabel} variant="rail" />
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="psh-main">
        <header className="psh-top">
          {buildScoped ? (
            <>
              {/* Desktop: full "build › section" breadcrumb. Mobile: the build
                  name alone (the bottom tab bar carries the section). */}
              <span className="psh-top-crumbs psh-top-title--desk" aria-label="Breadcrumb">
                <span className="psh-crumb-build">{activeBuild!.name}</span>
                <ChevronRight className="psh-crumb-sep" />
                <span className="psh-crumb-here" aria-current="page">
                  {crumb ?? (section ? SECTION_LABEL[section] : 'Overview')}
                </span>
              </span>
              <span className="psh-top-title psh-top-title--mob">{activeBuild!.name}</span>
            </>
          ) : (
            <>
              <span className="psh-top-title psh-top-title--desk">Portfolio</span>
              <span className="psh-top-title psh-top-title--mob">Builds</span>
            </>
          )}

          {buildScoped ? (
            <Link className="psh-create" href={`/projects/${bid}/change-orders/new`}>
              <PlusIcon />
              Log a change
            </Link>
          ) : (
            <Link className="psh-create" href={NEW_BUILD_HREF}>
              <PlusIcon />
              Create build
            </Link>
          )}

          <AccountMenu displayName={user.displayName} roleLabel={user.roleLabel} variant="bar" />
        </header>

        {/* BUILD mode bodies (the record, the plan) own their own padding — the
            same gutter they had under the old chrome — so the shell body runs
            flush and does not double-pad. */}
        <main
          className={`psh-body${align === 'start' ? ' psh-body--start' : ''}${buildScoped ? ' psh-body--flush' : ''}`}
        >
          {children}
        </main>

        {/* Mobile bottom tabs. In build mode they go live (Plan is the record
            home); in portfolio mode only Builds is active and the rest dim. */}
        <nav className="psh-tabs" aria-label="Primary">
          {buildScoped ? (
            <Link className="psh-tab" href="/">
              <GridIcon />
              Builds
            </Link>
          ) : (
            <span className="psh-tab is-active" aria-current="page">
              <GridIcon />
              Builds
            </span>
          )}
          {buildScoped ? (
            <Link
              className={`psh-tab${section === 'overview' || section === 'plan' ? ' is-active' : ''}`}
              href={`/projects/${bid}`}
              aria-current={section === 'overview' ? 'page' : undefined}
            >
              <CalendarIcon />
              Plan
            </Link>
          ) : (
            <span className="psh-tab is-dim">
              <CalendarIcon />
              Plan
            </span>
          )}
          <span className="psh-tab is-dim">
            <FolderIcon />
            Docs
          </span>
          <span className="psh-tab is-dim">
            <MenuIcon />
            More
          </span>
        </nav>
      </div>
    </div>
  );
}

/* The live build switcher (BUILD mode). A native <details> so the shell stays a
   server component — the same server-friendly popover the account menu and the
   record "More" nav use. Lists every build the user can switch to; the current
   one is marked and the rest are links straight to their record home. */
function BuildSwitcher({ active, builds }: { active: BuildRef; builds: BuildRef[] }) {
  // The active build is always offered even if the caller passed a partial list.
  const others = builds.filter((b) => b.id !== active.id);
  return (
    <details className="psh-switch-d">
      <summary className="psh-switch" aria-label={`Build: ${active.name}. Switch build.`}>
        <span className="psh-switch-col">
          <span className="psh-switch-kicker">BUILD</span>
          <span className="psh-switch-val psh-switch-val--live">{active.name}</span>
        </span>
        <ChevronsUpDown />
      </summary>
      <div className="psh-switch-pop" role="menu">
        <span className="psh-switch-cur" aria-current="true">
          <CheckIcon />
          {active.name}
        </span>
        {others.map((b) => (
          <Link key={b.id} role="menuitem" className="psh-switch-opt" href={b.href ?? `/projects/${b.id}`}>
            {b.name}
          </Link>
        ))}
        <Link role="menuitem" className="psh-switch-all" href="/">
          <GridIcon />
          All builds
        </Link>
      </div>
    </details>
  );
}

/* The live "THIS BUILD" nav (BUILD mode). Overview + Plan (with its Schedule /
   Money / History sub-items) + Documents. `section` highlights the current one;
   Documents stays dimmed until a documents surface exists. */
function BuildNav({ buildId, section }: { buildId: string; section?: BuildSection }) {
  const item = (s: BuildSection, icon: React.ReactNode, opts?: { sub?: boolean; caret?: boolean }) => {
    const href = sectionHref(buildId, s);
    const active = section === s;
    const cls = `psh-nav-item${opts?.sub ? ' is-sub' : ''}${active ? ' is-active' : ''}`;
    if (href == null) {
      // Documents — no surface yet.
      return (
        <span className={`${cls} is-dim`} title="No documents surface yet">
          {icon}
          {SECTION_LABEL[s]}
        </span>
      );
    }
    return (
      <Link className={cls} href={href} aria-current={active ? 'page' : undefined}>
        {icon}
        {SECTION_LABEL[s]}
        {opts?.caret ? <ChevronRight className="psh-nav-caret" /> : null}
      </Link>
    );
  };

  return (
    <>
      {item('overview', <HouseIcon />)}
      {item('plan', <CalendarIcon />, { caret: true })}
      {item('schedule', null, { sub: true })}
      {item('money', null, { sub: true })}
      {item('history', null, { sub: true })}
      {item('documents', <FolderIcon />)}
    </>
  );
}

/* Icons are inline (same convention as EmptyPortal): the components/icons.tsx
   set is drawn for the record's 21px bottom-nav grid, and these sit at the
   pen's rail sizes. All stroke `currentColor` so a node's colour drives its
   glyph — the active-vs-dimmed split is one `color` change, never a second
   asset. */
function HouseMark() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M9 21v-6h6v6" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </svg>
  );
}

function HouseIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M3 11l9-7 9 7M5 10v10h14V10" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M3.5 6.5a1 1 0 0 1 1-1h4l2 2.5h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}

function ChevronsUpDown() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="presentation" className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
