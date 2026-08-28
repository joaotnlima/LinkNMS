// Sign-in (LINA-57).
//
// ⚠️ READ services/../app/src/server/signin.ts BEFORE ENABLING THIS.
//
// ADR-0001 specifies magic-link sign-in: prove control of an email address, then
// get a cookie. The cookie half is production-grade; the PROOF half needs an
// email integration that does not exist yet. So this form trades an email for a
// session with NO proof, and the whole thing is refused unless
// LINKNMS_OPEN_SIGNIN=1 is explicitly set.
//
// When it is off, this page says so plainly instead of rendering a form that
// would fail on submit — and it says it WITHOUT implying the deploy is broken,
// because off is the correct default for production.
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { signInAction } from '@/app/actions';
import { openSignInEnabled } from '@/server/signin';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Never reflect an absolute URL back into the form — the action re-checks, but
  // an open redirect should not be one missing check away.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  if (!openSignInEnabled()) {
    return (
      <>
        <TopBar />
        <main className="screen">
          <h1 className="scr">Sign-in is not available here</h1>
          <p className="sub">
            This deployment does not have a sign-in method configured. Email-link sign-in is not
            built yet; ask whoever runs this environment for access.
          </p>
        </main>
      </>
    );
  }

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
          <ActionForm
            action={signInAction}
            submitLabel="Continue"
            pendingLabel="Signing in…"
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
