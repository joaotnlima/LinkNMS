// D1-new — the first-time empty portal state (LINA-133, LINA-118 Phase 3).
//
// Where it is reached from: onboarding/setup (D0a-setup, LINA-132) redirects
// here on a completed profile, so this is the first thing an onboarded user
// sees with an account and no build.
//
// DESIGN SOURCE, stated because it is not the one the ticket names. There is no
// renderable `D1-new` frame in cowork/pen/linkNMS.pen: the onboarding frames
// added by LINA-120 (`OnboardD-1`, `OnboardD0a`, `OnboardD1`, …) are placeholder
// shells that all carry the same two children — the D0 Sign-in artboard. The
// screen that IS this state and IS drawn is `D1 · Portfolio — empty`
// (id `L0S1B0`, Desktop — Bootstrap flow > Band B). Heading, lede and both
// button labels below are lifted verbatim from it rather than paraphrased.
//
// Two deliberate departures from that frame, both scope calls:
//
//  1. No 260px nav rail. The pen draws the full portal chrome around the empty
//     state — a build switcher plus Overview / Plan / Schedule / Money /
//     History / Documents. Every one of those needs a build to point at, so in
//     the empty state they are dead controls; and introducing an app shell here
//     would restyle every record route. The rail belongs with the first
//     non-empty portfolio screen, not with this ticket.
//  2. A three-step "Getting started" list, which the pen does not draw. The
//     ticket asks for clear guidance on next steps, and the steps are a
//     decomposition of the pen's own lede sentence, not new product.
//
// The `name` prop personalises the heading. Nothing passes it yet — the app has
// no `GET /me`, the session carries `partyId` only and `display_name` lives
// behind the identity store. It is left as a prop rather than derived from an
// email local-part: greeting someone "Welcome, joao.ferreirafilhos" is worse
// than greeting nobody.
import Link from 'next/link';

import './empty-portal.css';

// Inter now loads globally from the portal layout (LINA-156), and this screen
// draws from the migrated globals.css token set rather than a scoped palette,
// so it no longer scopes its own font — see empty-portal.css.
const NEW_BUILD_HREF = '/projects/new';
const INVITE_HREF = '/invitations/accept';

export function EmptyPortal({ name }: { name?: string }) {
  return (
    <main className="onb">
      <section className="onb-state">
        <span className="onb-disc" aria-hidden="true">
          <BlueprintIcon />
        </span>

        <h1 className="onb-title">{name ? `No builds yet, ${name}` : 'No builds yet'}</h1>

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

      <section className="onb-steps" aria-labelledby="onb-steps-head">
        <h2 className="onb-steps-head" id="onb-steps-head">
          Getting started
        </h2>
        <ol>
          <li className="onb-step">
            <span>
              <span className="onb-step-name">Create the build</span>
              <span className="onb-step-blurb">
                Name it, set the baseline budget and the dates you agreed. That baseline is what
                every later change is measured against.
              </span>
            </span>
          </li>
          <li className="onb-step">
            <span>
              <span className="onb-step-name">Choose how it is contracted</span>
              <span className="onb-step-blurb">
                Turnkey, direct-to-specialty, or a mix. This decides who can propose work and who
                has to approve it.
              </span>
            </span>
          </li>
          <li className="onb-step onb-step--builder">
            <span>
              <span className="onb-step-name">Invite your contractor</span>
              <span className="onb-step-blurb">
                They accept and the record opens for both of you. Nothing you record before then is
                lost — it is the same build, now shared.
              </span>
            </span>
          </li>
        </ol>
      </section>

      <p className="onb-note">
        Were you invited to someone else&rsquo;s build? Use{' '}
        <Link href={INVITE_HREF}>I have an invite code</Link> instead — you do not need to create
        anything. Already on a record? Open it by its link; every build has a permanent URL.
      </p>
    </main>
  );
}

/* Icons are inline rather than imported from components/icons.tsx: those are
   drawn on the globals.css 21px grid for the bottom nav, and these two sit at
   the pen's 26px / 15px sizes inside the onboarding palette. */
function BlueprintIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M3 20V7l9-4 9 4v13" />
      <path d="M3 20h18" />
      <path d="M9 20v-6h6v6" />
      <path d="M3 11h18" />
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
