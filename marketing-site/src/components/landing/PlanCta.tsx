'use client';

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { track } from '@/lib/analytics-client';
import { setPlanIntent } from '@/lib/plan-intent';
import type { PaidPlanKey } from '@/lib/pricing';

// A paid-plan call-to-action (LINA-175). Asks /api/checkout what should happen
// for this plan and follows the answer:
//
//   { flow: 'waitlist' } — founding free seats remain, so paid intent is still
//                          collected through the waitlist: carry the plan to
//                          the form at #request-access.
//   { flow: 'checkout', url } — seats full: hand off to hosted Stripe Checkout.
//
// Analytics: `cta_click` fires exactly as <CtaLink> fires it, at click time,
// with the same `cta_location`/`cta_action` pair. The click itself is unchanged
// — a pricing CTA press — so the waitlist-intent number keeps counting exactly
// what it counted before; `plan` is added as a property, and no new event name
// is invented (`landing-event-map-v2` §3.2 — see CtaLink.tsx).
//
// Progressive enhancement: the element stays an <a href="#request-access">, so
// with JS off (or if the fetch fails) the visitor still lands in the waitlist
// form — the pre-LINA-175 behaviour.
export function PlanCta({
  plan,
  label,
  className,
  children
}: {
  plan: PaidPlanKey;
  /** Localized plan name, carried to the waitlist form for display. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function toWaitlist() {
    setPlanIntent({ plan, label });
    const target = document.getElementById('request-access');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.history.replaceState(null, '', '#request-access');
    } else {
      window.location.hash = 'request-access';
    }
  }

  async function onClick(e: MouseEvent<HTMLAnchorElement>) {
    track('cta_click', { cta_location: 'pricing', cta_action: 'request_access', plan });
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, locale })
      });
      const data = (await res.json().catch(() => null)) as
        | { flow?: string; url?: string }
        | null;

      if (res.ok && data?.flow === 'checkout' && typeof data.url === 'string' && data.url) {
        // Leaving the page — stay "busy" so a second press can't double-fire.
        window.location.href = data.url;
        return;
      }
    } catch {
      /* offline / blocked — fall through to the waitlist, same as JS-off */
    }

    // Every non-checkout outcome (flow:'waitlist', and any 4xx/5xx the visitor
    // can do nothing about) lands in the waitlist form rather than dead-ending.
    toWaitlist();
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <a
      className={className}
      href="#request-access"
      onClick={onClick}
      aria-busy={busy || undefined}
      data-plan={plan}
    >
      {children}
    </a>
  );
}
