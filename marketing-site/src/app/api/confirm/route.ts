import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, isDbConfigured, signups } from '@/lib/db';
import { capture } from '@/lib/analytics';

export const runtime = 'nodejs';

const LOCALES = new Set(['pt', 'en', 'es']);

// GET /api/confirm?token=… → mark 'confirmed', then redirect to the localized
// landing page with a success (or invalid) banner.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';

  // Determine the locale to land on from a cookie set by next-intl, else default.
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/NEXT_LOCALE=([^;]+)/);
  const locale = match && LOCALES.has(match[1]) ? match[1] : 'pt';

  const dest = (ok: boolean) =>
    new URL(`/${locale}?${ok ? 'confirmed=1' : 'confirm=invalid'}#contact`, url.origin);

  if (!token || !isDbConfigured()) {
    return NextResponse.redirect(dest(false));
  }

  const db = getDb();
  const rows = await db
    .select({ id: signups.id, emailNorm: signups.emailNorm, status: signups.status })
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
  }

  return NextResponse.redirect(dest(true));
}
