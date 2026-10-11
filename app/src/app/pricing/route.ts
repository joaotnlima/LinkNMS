// /pricing (PRD-12 N-11; to-be/20 lists it as a public URL). The marketing site
// owns pricing — numbers and plans live on the landing page and are out of the
// app's scope (AGENT-INDEX §1) — so the app's /pricing is a stable address that
// sends the visitor to the landing pricing section, never a second, drifting
// pricing table.
import { NextResponse } from 'next/server';

import { PRICING_URL } from '@/lib/plans';

export function GET() {
  return NextResponse.redirect(PRICING_URL, 307);
}
