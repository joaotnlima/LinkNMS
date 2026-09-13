// The frame both token-scoped pages sit in (LINA-284) — ADR-0023 §6.
//
// A masthead, a centred column, and a footer line. It is NOT AuthShell: that
// component is the sign-in door, and its three trust lines and "Secured by
// Clerk" legal line are all untrue for a contractor who will never hold an
// account here (see the header comment in rfp-public.css).
//
// The footer line is load-bearing rather than decorative. This is the only
// screen in the product a person reaches with no session, and the first
// question it has to answer is "why am I being shown this, and do I have to
// sign up?". Saying so in one sentence, on every state of the page, is cheaper
// than the support email that question otherwise becomes.
import type { ReactNode } from 'react';

import { Mark } from '@/components/icons';
import './rfp-public.css';

export function RfpShell({ children }: { children: ReactNode }) {
  return (
    <div className="rfp">
      <header className="rfp-mast">
        <span className="rfp-brand">
          <Mark />
          <span>LinkNMS</span>
        </span>
        <span className="rfp-kicker">Request for proposal</span>
      </header>

      <main className="rfp-col">{children}</main>

      <p className="rfp-foot">
        You reached this page from an invitation link. No LinkNMS account is needed
        to send a proposal.
      </p>
    </div>
  );
}

/**
 * The whole-page states: loading, a dead link, and the thank-you.
 *
 * One component for all three because they are the same shape — a glyph, a
 * sentence that ends the visit or explains the wait, and nothing to do. Giving
 * each its own layout is how three screens that should read identically drift
 * apart.
 */
export function RfpState({
  tone, glyph, title, children,
}: {
  tone: 'done' | 'dead' | 'wait';
  glyph: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className={`rfp-state is-${tone}`} aria-live="polite">
      {glyph}
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/** A circled tick — the thank-you page's mark. */
export const DoneGlyph = (
  <svg className="rfp-state-mark" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.2l2.6 2.6L16 9.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A closed envelope with a slash — the dead-link mark. */
export const DeadGlyph = (
  <svg className="rfp-state-mark" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor">
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3.5 7l8.5 6 8.5-6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 20L20 4" strokeLinecap="round" />
  </svg>
);
