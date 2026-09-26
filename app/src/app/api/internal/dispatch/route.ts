// Internal outbox drain — the cron safety net behind the after() trigger in
// /api/v2 (see server/v2/dispatcher.ts). NOT part of the API contract: no
// session, no ViewerContext; Vercel cron authenticates with CRON_SECRET
// (Authorization: Bearer <secret>, the header Vercel sends on cron requests).
// Schedule lives in app/vercel.json.
import { NextRequest, NextResponse } from 'next/server';

import { dispatchOutbox } from '@/server/v2/dispatcher';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const dispatched = await dispatchOutbox();
  return NextResponse.json({ dispatched });
}
