// Sign-in (LINA-57 shell; magic-link proof half added in LINA-76 / ADR-0007).
//
// TWO doors, one page:
//   * Production (default): magic-link sign-in. The form only REQUESTS an emailed
//     link; the session is minted later when /auth/callback consumes the token.
//     This is the PROOF half of ADR-0001 — a party proves control of their email
//     before getting a cookie.
//   * Demo/preview (LINKNMS_OPEN_SIGNIN=1): the no-proof form that trades an
//     email for a session immediately. Kept exactly as it was for LINA-75's
//     acceptance walkthrough; it is never enabled on production.
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { signInAction, requestSignInLinkAction } from '@/app/actions';
import { openSignInEnabled } from '@/server/signin';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sent?: string }>;
}) {
  const { next, sent } = await searchParams;
  // Never reflect an absolute URL back into the form — the action re-checks, but
  // an open redirect should not be one missing check away.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  // ── Demo/preview: the no-proof open-signin form (unchanged) ─────────────────
  if (openSignInEnabled()) {
    return (
      <>
        <TopBar />
        <main className="screen">
          <div>
            <div className="crumbs">LinkNMS</div>
            <h1 className="scr">Sign in</h1>
            <p className="sub">
              Everything you record is attributed to you by name and time-stamped.
            </p>
          </div>

          <section className="card">
            <ActionForm action={signInAction} submitLabel="Continue" pendingLabel="Signing in…">
              <input type="hidden" name="next" value={safeNext} />
              <label className="field">
                <span className="metric-lbl">Email</span>
                <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
              </label>
              <label className="field">
                <span className="metric-lbl">Your name</span>
                <input
                  name="displayName"
                  type="text"
                  autoComplete="name"
                  placeholder="How you should appear on the record"
                  aria-describedby="name-help"
                />
              </label>
              <span id="name-help" className="cap">
                This is the name shown beside every decision you make.
              </span>
            </ActionForm>
            <p className="cap" role="note" style={{ marginTop: 12 }}>
              <span aria-hidden="true">⚠ </span>
              Preview environment: this does not yet verify your email address.
            </p>
          </section>
        </main>
      </>
    );
  }

  // ── Production: "check your email" confirmation after a link was requested ──
  // Shown for known AND unknown emails alike — the copy must never reveal which
  // (ADR-0007 §4).
  if (sent) {
    return (
      <>
        <TopBar />
        <main className="screen">
          <div>
            <div className="crumbs">LinkNMS</div>
            <h1 className="scr">Check your email</h1>
            <p className="sub">
              If that address can sign in, a one-time link is on its way. It works once and expires
              in 15 minutes.
            </p>
          </div>
          <section className="card">
            <p className="cap">
              Didn&rsquo;t get it? Check spam, then <a href="/sign-in">request another link</a>.
            </p>
          </section>
        </main>
      </>
    );
  }

  // ── Production: request a magic link ────────────────────────────────────────
  return (
    <>
      <TopBar />
      <main className="screen">
        <div>
          <div className="crumbs">LinkNMS</div>
          <h1 className="scr">Sign in</h1>
          <p className="sub">
            Enter your email and we&rsquo;ll send you a one-time sign-in link. Everything you record
            is attributed to you by name and time-stamped.
          </p>
        </div>

        <section className="card">
          <ActionForm
            action={requestSignInLinkAction}
            submitLabel="Send sign-in link"
            pendingLabel="Sending…"
          >
            <input type="hidden" name="next" value={safeNext} />
            <label className="field">
              <span className="metric-lbl">Email</span>
              <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
            </label>
            <label className="field">
              <span className="metric-lbl">Your name</span>
              <input
                name="displayName"
                type="text"
                autoComplete="name"
                placeholder="How you should appear on the record"
                aria-describedby="name-help"
              />
            </label>
            <span id="name-help" className="cap">
              Shown beside every decision you make. Used only if this is your first sign-in.
            </span>
          </ActionForm>
        </section>
      </main>
    </>
  );
}
