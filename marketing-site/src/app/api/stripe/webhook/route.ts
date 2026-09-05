import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { capture } from '@/lib/analytics';

export const runtime = 'nodejs';

/**
 * POST /api/stripe/webhook — verified Stripe event delivery.
 *
 * THIN by design (LINA-173): records the paid signup for analytics and emits
 * it to the waitlist funnel. Seat provisioning (`identity.seat` rows with
 * `source='stripe'`, revocation on cancellation) is the APP's job per
 * ADR-0008 §7 and is gated on the Architect at launch — intentionally not
 * implemented here, because the marketing site has no write to the identity
 * schema. Signature always verified against STRIPE_WEBHOOK_SECRET; every
 * verified event is acknowledged 200 even if unhandled.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const plan = (session.metadata?.plan || 'unknown').slice(0, 40);
        const email =
          session.customer_details?.email || session.customer_email || session.id;
        await capture('checkout_session_completed', email, {
          plan,
          sessionId: session.id,
          subscription: session.subscription,
          amount_subtotal: session.amount_subtotal,
          currency: session.currency
        });
        break;
      }
      default:
        break; // verified delivery acknowledged; nothing to do yet
    }
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', err);
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}