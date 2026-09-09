// D1-new — the first-time empty portal state (LINA-133, restyled LINA-216).
//
// Where it is reached from: onboarding/setup (D0a-setup, LINA-132) redirects
// here on a completed profile, so this is the first thing an onboarded user
// sees with an account and no build.
//
// DESIGN SOURCE. The screen that IS this state and IS drawn is `D1 · Portfolio —
// empty` (Desktop — Bootstrap flow > Band B), with its mobile counterpart
// `M1 · No builds yet`. Heading, lede and both button labels are lifted verbatim.
//
// WHAT CHANGED IN LINA-216. LINA-133 shipped this body bare inside the 780px
// reading column and made two deliberate departures from the pen: it dropped the
// nav rail ("the rail belongs with the first non-empty portfolio screen") and
// added a three-step "Getting started" list the pen never drew. The founder's
// side-by-side (this ticket) asked for the pen as drawn, so both departures are
// now reverted: the body renders inside <PortalShell/> (rail + top bar on
// desktop, app bar + tab bar on mobile) and the empty state is just the icon,
// heading, lede and the two CTAs — no steps list, no footnote.
import Link from 'next/link';

import { PortalShell, type PortalUser } from './PortalShell';
import './empty-portal.css';

const NEW_BUILD_HREF = '/projects/new';
const INVITE_HREF = '/invitations/accept';

export function EmptyPortal({ user }: { user: PortalUser }) {
  return (
    <PortalShell user={user}>
      <section className="onb-state">
        <span className="onb-disc" aria-hidden="true">
          <HousePlusIcon />
        </span>

        <h1 className="onb-title">No builds yet</h1>

        <p className="onb-lede">
          Create the build, choose how it is contracted, and invite your contractor. From that point
          every date, every euro and every change lives in one record both of you can read.
        </p>

        <div className="onb-cta">
          <Link className="onb-btn onb-btn--primary" href={NEW_BUILD_HREF}>
            <PlusIcon />
            Create your first build
          </Link>
          <Link className="onb-btn onb-btn--secondary" href={INVITE_HREF}>
            I have an invite code
          </Link>
        </div>
      </section>
    </PortalShell>
  );
}

/* Icons inline at the pen's empty-state sizes (26px disc glyph, 15px in the
   button). `house-plus` — a house with a plus — is the pen's own choice here,
   reading as "add the first build". */
function HousePlusIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M3 10.5 12 4l6 4.6" />
      <path d="M5 9.8V20h6.5" />
      <path d="M15 17h6M18 14v6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
