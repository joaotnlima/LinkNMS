// PortalShell — the portal app chrome (LINA-216).
//
// Desktop: a 260px left rail (brand, build switcher, the active Portfolio nav,
// the build-scoped nav, and a user footer) beside a top bar + body. Mobile: an
// app bar + body + a four-tab bottom bar. This is the frame the pen draws
// around the portfolio; before this ticket the home route rendered its body
// bare inside the 780px reading column and there was no chrome at all.
//
// WHY THE BUILD-SCOPED CONTROLS ARE INERT. The build switcher and the "THIS
// BUILD" nav (Overview / Plan / Schedule / Money / History / Documents on
// desktop, Plan / Docs / More on mobile) all need a selected build to point at.
// In the empty state there is none, so they render exactly as the pen draws
// them — present, dimmed, non-interactive — rather than as links to nowhere.
// They become live when this shell is adopted by a build-scoped surface; the
// contract here is deliberately "chrome, no dead links".
//
// FULL-BLEED. This is a child of globals.css `.shell` (a 780px reading column,
// right for the record and wrong for a portfolio app). portal-shell.css widens
// the shell only when its child IS this component — the same `:has()` escape
// AuthShell uses (see auth-shell.css).
import Link from 'next/link';

import './portal-shell.css';

const NEW_BUILD_HREF = '/projects/new';

export type PortalUser = { displayName: string; roleLabel: string };

// "Marta Silva" → "MS". First and last initial; a single name gives one letter.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function PortalShell({ user, children }: { user: PortalUser; children: React.ReactNode }) {
  return (
    <div className="psh">
      {/* ── Left rail (desktop) ─────────────────────────────────────────── */}
      <aside className="psh-rail" aria-label="Portal">
        <div className="psh-brand">
          <HouseMark />
          <span>LinkNMS</span>
        </div>

        <div className="psh-switch" aria-disabled="true">
          <span className="psh-switch-col">
            <span className="psh-switch-kicker">BUILD</span>
            <span className="psh-switch-val">No builds yet</span>
          </span>
          <ChevronsUpDown />
        </div>

        <nav className="psh-nav" aria-label="Portal sections">
          <span className="psh-nav-item is-active" aria-current="page">
            <GridIcon />
            Portfolio
          </span>

          <span className="psh-nav-group">This build</span>
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
        </nav>

        <div className="psh-user">
          <span className="psh-avatar" aria-hidden="true">
            {initials(user.displayName)}
          </span>
          <span className="psh-user-col">
            <span className="psh-user-name">{user.displayName}</span>
            <span className="psh-user-role">{user.roleLabel}</span>
          </span>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="psh-main">
        <header className="psh-top">
          <span className="psh-top-title psh-top-title--desk">Portfolio</span>
          <span className="psh-top-title psh-top-title--mob">Builds</span>

          <Link className="psh-create" href={NEW_BUILD_HREF}>
            <PlusIcon />
            Create build
          </Link>

          <span
            className="psh-account"
            title={`${user.displayName} · ${user.roleLabel}`}
            aria-label={`Signed in as ${user.displayName}`}
          >
            <UserCircle />
          </span>
        </header>

        <main className="psh-body">{children}</main>

        <nav className="psh-tabs" aria-label="Primary">
          <span className="psh-tab is-active" aria-current="page">
            <GridIcon />
            Builds
          </span>
          <span className="psh-tab is-dim">
            <CalendarIcon />
            Plan
          </span>
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

function UserCircle() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 18.5a6 6 0 0 1 11 0" />
    </svg>
  );
}
