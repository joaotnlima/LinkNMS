import { NextResponse } from 'next/server';

import { foundingSeats } from '@/lib/seats';

export const runtime = 'nodejs';
// The count changes as people claim, so it must never be captured at build time
// or served from a stale edge cache — the whole point of the number is that it
// is true right now.
export const dynamic = 'force-dynamic';

/**
 * GET /api/seats → { claimed, total, remaining }
 *
 * Public and unauthenticated, because the number it returns is already printed
 * on the landing page. It exposes only the aggregate — never an address, never
 * who holds a seat.
 */
export async function GET() {
  const seats = await foundingSeats();
  return NextResponse.json(seats, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
