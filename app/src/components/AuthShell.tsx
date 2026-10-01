// D0 · Sign in — the split-screen auth shell (LINA-191, pen `Desktop —
// Bootstrap flow (lg) › Band A · Account`).
//
// WHAT CHANGED. The pen replaced the old single centred card with a two-panel
// door: a photograph of a finished build on the left carrying the promise, the
// credential card on the right carrying the work. The mobile artboard in the
// same band (`D0 · Sign in · Mobile`, 390×820) is the SAME screen with the
// photo collapsed to a 230px header, so this is one component with a breakpoint
// rather than two screens — the previous pen kept desktop and mobile in separate
// bands, and they drifted.
//
// WHAT THIS DOES NOT DO. It does not render a credential form. The SSO buttons,
// the email/password fields and the "or" divider in the artboard are Clerk's
// prebuilt <SignIn/>/<SignUp/> (Clerk Integration spec, LINA-129 §6 — we host
// and brand, we never hand-roll a password field). This file is the frame around
// that card plus the two pieces of copy the artboard puts OUTSIDE it: the title
// block above (Clerk's own header is hidden in `authShellAppearance`, so the
// wording is ours on both doors and in the keyless preview) and the legal line
// below.
import type { ReactNode } from 'react';

import { Mark } from '@/components/icons';
import './auth-shell.css';

/** Pen `Trust` — one line, badge-check in Plan Closed green. */
function TrustLine({ children }: { children: ReactNode }) {
  return (
    <li>
      <svg className="au-tick" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3l2.1 1.6 2.6-.2.9 2.5 2.1 1.6-1 2.5 1 2.5-2.1 1.6-.9 2.5-2.6-.2L12 21l-2.1-1.6-2.6.2-.9-2.5L4.3 15l1-2.5-1-2.5 2.1-1.6.9-2.5 2.6.2z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{children}</span>
    </li>
  );
}

export type AuthShellProps = {
  /** Card heading — pen `Auth › Card › H` ("Sign in to LinkNMS"). */
  title: string;
  /** Card sub — pen `Auth › Card › D`. */
  description: string;
  /**
   * Brand-panel headline. The artboards word this differently by size (the
   * 620px panel gets the full sentence, the 230px header gets the short one),
   * so both ship and CSS picks — the alternative is a client-side width probe
   * on the first paint of the first screen anyone sees.
   */
  promise: string;
  promiseShort: string;
  /** The Clerk card, or the keyless-preview notice. */
  children: ReactNode;
  /**
   * Replaces the default legal line (LINA-225). The default names Clerk because
   * the two doors hand the credential step to Clerk; the invitation-accept
   * surface does not — the visitor is already signed in and is posting a code to
   * our own action — so crediting Clerk there would be decoration, not a fact.
   */
  legal?: ReactNode;
};

export function AuthShell({ title, description, promise, promiseShort, children, legal }: AuthShellProps) {
  return (
    <main className="au">
      <aside className="au-brand">
        {/* Decorative: the promise is in the copy beside it, so the photograph
            adds no information a screen reader is missing. */}
        <picture className="au-brand__photo" aria-hidden="true">
          <source
            type="image/avif"
            srcSet="/images/stage-4-house-built-700.avif 700w, /images/stage-4-house-built-1400.avif 1400w"
            sizes="(min-width: 1024px) 620px, 100vw"
          />
          <source
            type="image/webp"
            srcSet="/images/stage-4-house-built-700.webp 700w, /images/stage-4-house-built-1400.webp 1400w"
            sizes="(min-width: 1024px) 620px, 100vw"
          />
          {/* Eager and high priority: this is the largest paint on the route and
              it sits above the fold on both artboards. */}
          <img
            src="/images/stage-4-house-built-1400.webp"
            alt=""
            width={1400}
            height={1120}
            decoding="async"
            fetchPriority="high"
          />
        </picture>
        <span className="au-brand__scrim" aria-hidden="true" />

        <div className="au-brand__top">
          <Mark className="au-brand__mark" />
          <span className="au-brand__word">LinkNMS</span>
        </div>

        <div className="au-brand__copy">
          <p className="au-brand__promise">{promise}</p>
          <p className="au-brand__promise au-brand__promise--short">{promiseShort}</p>
          <ul className="au-brand__trust">
            <TrustLine>Owners, builders and their whole team</TrustLine>
            <TrustLine>Blue is the plan, orange is change, green is done</TrustLine>
            <TrustLine>Invited once — one login for every project</TrustLine>
          </ul>
        </div>
      </aside>

      <section className="au-panel">
        <div className="au-col">
          <div className="au-head">
            <h1 className="au-title">{title}</h1>
            <p className="au-desc">{description}</p>
          </div>

          {children}

          {/* Pen `Legal`. Terms and Privacy are named, not linked: neither page
              exists yet on the marketing site, and a legal link that 404s is
              worse than a legal line that does not pretend to be one. Flagged on
              LINA-191 — swap the spans for anchors the day the pages ship. */}
          <p className="au-legal">
            {legal ?? 'By continuing you agree to the Terms and Privacy Policy. Secured by Clerk.'}
          </p>
        </div>
      </section>
    </main>
  );
}
