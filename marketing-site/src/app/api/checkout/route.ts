import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { foundingSeats } from '@/lib/seats';
import { isPaidPlanKey, isStripeConfigured, priceIdForPlan } from '@/lib/pricing';
import { isValidEmail } from '@/lib/spam';

export const runtime = 'nodejs';

type Body = {
  plan?: string;
  email?: string;
  locale?: string;
};

function baseUrl(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, '');
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * POST /api/checkout — start the checkout flow for a paid plan.
 *
 * Body:   { plan: PaidPlanKey, email?: string, locale?: string }
 * 200 →   { flow: 'waitlist', plan, seats:{claimed,total,remaining} }
 *         (pre-launch: founding free seats remain; user completes the
 *          waitlist, which records the paid-plan intent — see /api/waitlist)
 * 200 →   { flow: 'checkout', url }  (founder seats full; user follows `url`)
 * 400 →   { error: 'invalid_plan' | 'invalid_email' | 'bad_request' }
 * 503 →   { error: 'not_configured' } (STRIPE keys or a price ID missing)
 * 502 →   { error: 'upstream' } (Stripe API failure)
 *
 * Prices are NEVER taken from the client — the plan key maps to a server-side
 * Stripe Price ID. Callers only ever send the plan enum key.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const plan = (body.plan || '').trim();
  if (!isPaidPlanKey(plan)) {
    return NextResponse.json({ error: 'invalid_plan' }, { status: 400 });
  }

  const email = (body.email || '').trim();
  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  // Founder's charge-mode decision (LINA-173): while founding free seats
  // remain, paid intent is collected through the waitlist — no Stripe session.
  // Once all 50 founding seats are claimed, paid plans go to hosted checkout.
  //
  // Counted through `foundingSeats()` — the same definition the landing page
  // prints and the same rows the database cap enforces (LINA-189), so the
  // number a visitor is shown and the number that decides their flow can never
  // disagree. It used to count `landing.signups` rows here and render a
  // hardcoded 18 on the page, which were two different answers to one question.
  const seats = await foundingSeats();
  if (seats.remaining > 0) {
    return NextResponse.json({ flow: 'waitlist', plan, seats });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const base = baseUrl(req);
  const priceId = priceIdForPlan(plan)!;

  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/?checkout=success&plan=${encodeURIComponent(plan)}`,
      cancel_url: `${base}/#pricing`,
      customer_email: email || undefined,
      locale: 'auto',
      metadata: { plan, source: 'pricing_section' }
    });
  } catch (err) {
    console.error('[checkout] Stripe session creation failed:', err);
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }

  if (!session.url) {
    console.error('[checkout] Stripe returned a session without a URL');
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }

  return NextResponse.json({ flow: 'checkout', url: session.url });
}