import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, isDbConfigured, signups } from '@/lib/db';
import { capture } from '@/lib/analytics';
import { sendWelcomeEmail } from '@/lib/email';
import { grantFoundingSeat, hasSeat, normalizeSeatEmail } from '@/lib/seats';
import { portalSignUpUrl } from '@/lib/portal';

export const runtime = 'nodejs';

const LOCALES = new Set(['pt', 'en', 'es']);

// GET /api/confirm?token=… — the hinge of the onboarding loop (LINA-189).
//
// Confirming used to do one thing: flip the signup to 'confirmed' and drop the
// visitor back on the landing page with a "you're on the list" banner. That was
// the end of the road — a seat then had to be granted by hand before the person
// could get in, so "claim my free seat" claimed nothing.
//
// It now completes the claim. Clicking the link in an inbox is the proof that
// the address is real, and for a signup that chose a plan that proof is exactly
// what a founding seat is owed to, so this grants the seat and sends the person
// on to the portal to create their profile. The seat is granted BEFORE the
// redirect on purpose: they arrive at Clerk already admitted, so the sign-up
// they are about to complete lands them on the record instead of at /no-access.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';

  // Determine the locale to land on from a cookie set by next-intl, else default.
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/NEXT_LOCALE=([^;]+)/);
  const locale = match && LOCALES.has(match[1]) ? match[1] : 'pt';

  const dest = (ok: boolean, extra = '') =>
    new URL(
      `/${locale}?${ok ? 'confirmed=1' : 'confirm=invalid'}${extra}#contact`,
      url.origin
    );

  if (!token || !isDbConfigured()) {
    return NextResponse.redirect(dest(false));
  }

  const db = getDb();
  const rows = await db
    .select({
      id: signups.id,
      email: signups.email,
      emailNorm: signups.emailNorm,
      locale: signups.locale,
      plan: signups.plan,
      status: signups.status
    })
    .from(signups)
    .where(eq(signups.confirmToken, token))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.redirect(dest(false));
  }

  const row = rows[0];
  if (row.status !== 'confirmed') {
    await db
      .update(signups)
      .set({ status: 'confirmed', confirmedAt: new Date(), confirmToken: null })
      .where(and(eq(signups.id, row.id), eq(signups.confirmToken, token)));
    await capture('waitlist_verified', row.emailNorm, { locale });
    // Successful waitlist signup (LINA-128): the double opt-in is complete, so
    // send the "you're on the list" welcome email. Degrades silently on failure.
    const welcomeLocale = (LOCALES.has(row.locale) ? row.locale : 'en') as
      | 'pt'
      | 'en'
      | 'es';
    await sendWelcomeEmail(row.email, welcomeLocale);
  }

  // ── THE CLAIM ──────────────────────────────────────────────────────────────
  // A signup that carried a plan asked for a seat: `free_founding` is the
  // founding-50 CTA outright, and while founding seats remain every paid owner
  // plan is ALSO collected through this funnel rather than through Stripe
  // (/api/checkout, the founder's pre-launch charge-mode decision). Both are
  // someone saying "I want to build on this", so both are honoured with a
  // founding seat. A plain waitlist signup with no plan is not a claim, and
  // still just lands on the list.
  if (!row.plan) {
    return NextResponse.redirect(dest(true));
  }

  const email = normalizeSeatEmail(row.emailNorm);
  if (!email) {
    return NextResponse.redirect(dest(true));
  }

  // Checked before inserting because the cap trigger runs ahead of ON CONFLICT:
  // once the fifty are gone, re-clicking the link of an address that ALREADY
  // holds a seat would otherwise be reported as "seats exhausted" and send a
  // seated person back to the waitlist.
  if (await hasSeat(email)) {
    return NextResponse.redirect(portalSignUpUrl(email));
  }

  const granted = await grantFoundingSeat(email, `founding claim · plan=${row.plan}`);
  if (granted.ok) {
    await capture('founding_seat_claimed', row.emailNorm, { locale, plan: row.plan });
    return NextResponse.redirect(portalSignUpUrl(email));
  }

  // Seats are gone (or the grant failed). Their signup is still confirmed and
  // on the list, so say so honestly rather than pretending the claim worked and
  // dropping them at a portal that will refuse them.
  return NextResponse.redirect(dest(true, '&seats=full'));
}
