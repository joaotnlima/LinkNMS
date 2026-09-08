// The plan-limit surface — what `409 plan_limit_reached` looks like (LINA-205).
//
// ── WHY THIS IS A SCREEN AND NOT A SENTENCE ──────────────────────────────────
// The service already returns a perfectly good sentence ("this plan runs 1
// active build; you already have 1") and until this component existed the wizard
// printed it in the same red strip it uses for "that baseline budget is not a
// valid amount". Those are not the same kind of failure. A malformed budget is
// the owner's mistake and retrying fixes it; this one is not a mistake at all —
// the request was well-formed, they are who they say they are, and the answer is
// still no. The strip invites a retry that will fail identically, forever.
//
// So: refuse honestly. Name the plan, state what it runs and how much of that is
// in use, and give the ways forward that actually exist. Nothing here is a
// generic conflict banner and nothing here is a scold.
//
// ── EVERY NUMBER ON THIS SCREEN CAME OFF THE WIRE ────────────────────────────
// `limit` and `owned` are the service's own, carried on the refusal for exactly
// this reason (ADR-0013). This file computes neither, and `@/lib/plans` holds
// display names only — see the long note there on why a second copy of the
// pricing table is the bug this design exists to prevent.
//
// ── THE TWO WAYS FORWARD, AND THE ONE THAT DOES NOT EXIST YET ────────────────
// ADR-0013 frames the refusal as "resolved by upgrading or by closing a build".
// Upgrading is real: the landing pricing section is live. CLOSING IS NOT — the
// only project statuses migration 0009 admits are `draft` and `active`, there is
// no transition out of either, and no service operation ends a build. So this
// screen does not draw a "close a build" button, and it does not tell the owner
// to go and do something the portal cannot do. It points at the portfolio, where
// they can see what is using the allowance, and it says plainly that ending a
// build is not self-serve yet. Tracked as the follow-up on LINA-205.
//
// ── THE UPGRADE CTA DOES NOT PROMISE A CHECKOUT ──────────────────────────────
// While founding seats remain, the landing site's paid CTAs hand the plan to the
// WAITLIST rather than to Stripe — the pre-launch charge-mode decision (LINA-173,
// and see `/api/checkout` in marketing-site, which counts claimed seats to decide
// which). An owner sent from here expecting a card form and met with an email
// field would rightly read that as a bait. The label says "See the plans" and the
// line under it says what happens, so the sentence is true in both modes and
// stays true on the day checkout flips on.
import Link from 'next/link';

import type { PlanLimit } from '@/lib/api';
import { planLabel, PRICING_URL } from '@/lib/plans';
import './plan-limit.css';

export function PlanLimitNotice({ entitlement }: { entitlement: PlanLimit }) {
  const { plan, limit, owned } = entitlement;
  const label = planLabel(plan);
  const builds = (n: number) => `${n} ${n === 1 ? 'build' : 'builds'}`;

  return (
    // role="alert" on the whole region, not just the heading: this replaces the
    // form's error strip, it appears only in response to a submit the owner just
    // made, and a screen-reader user who hears "You're already running…" without
    // the numbers or the ways forward has been told less than the sighted one.
    // No aria-labelledby: a live region is announced whole, so naming it would
    // only make the heading read twice. The id it would need is also the one
    // thing on this panel that could collide if a page ever showed two.
    <section className="pl" role="alert">
      <h2 className="pl-title">
        <span className="pl-glyph" aria-hidden="true">⛔</span>
        You&rsquo;re already running every build this plan allows
      </h2>

      {/* A definition list, not a sentence with numbers in it: the plan and the
          count are the two facts the owner will quote back at us, and they should
          be findable at a glance rather than parsed out of prose. */}
      <dl className="pl-facts">
        <div className="pl-fact">
          <dt>Your plan</dt>
          {/* `null` is the seat that carries no plan — a real state (hand-granted
              beta and invite seats), not a lookup failure. It gets a truthful
              phrase rather than the word "Unknown", which would read as a fault
              in their account. */}
          <dd>{label ?? 'Your current seat'}</dd>
        </div>
        <div className="pl-fact">
          <dt>Builds it runs</dt>
          <dd>{builds(limit)}</dd>
        </div>
        <div className="pl-fact">
          <dt>In use now</dt>
          {/* Not colour alone (FR9): the count says "2 of 2", so the fact that it
              is full is in the text and not only in the ramp this panel sits on. */}
          <dd>
            {owned} of {limit}
          </dd>
        </div>
      </dl>

      <p className="pl-body">
        Only the builds <strong>you own</strong> count towards this. Builds you were invited onto
        by someone else are always free, and drafts you started but have not committed still count
        — they are on your portfolio and they hold a name and a baseline.
      </p>

      <h3 className="pl-next-title">What you can do</h3>
      <ul className="pl-next">
        <li>
          <Link className="pl-link" href="/">
            See the builds you&rsquo;re running
          </Link>{' '}
          — check whether one of them is a draft you started and no longer need.
        </li>
        <li>
          <a className="pl-link" href={PRICING_URL}>
            See the plans
          </a>{' '}
          — larger plans run more builds at once. While the founding seats are still open, choosing
          one puts you on the list rather than through a checkout, and we come back to you.
        </li>
      </ul>

      <p className="pl-caveat">
        Ending a build isn&rsquo;t something you can do yourself yet, so nothing you have is at
        risk here — your existing builds and everything recorded on them are untouched.
      </p>
    </section>
  );
}
