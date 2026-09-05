import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, isDbConfigured, signups, PLAN_KEYS, type PlanKey } from '@/lib/db';
import { sendConfirmationEmail } from '@/lib/email';
import { capture } from '@/lib/analytics';
import { normalizeRole } from '@/lib/roles';
import {
  isValidEmail,
  normalizeEmail,
  isDisposable,
  verifyTurnstile,
  newToken
} from '@/lib/spam';

export const runtime = 'nodejs';

type Body = {
  email?: string;
  role?: string; // stable enum key (see @/lib/roles), never a localized label
  plan?: string; // tier key (see PLAN_KEYS in @/lib/db) — e.g. 'free_founding'
  company?: string; // honeypot — omitted by real clients, filled only by bots
  turnstileToken?: string;
  locale?: string;
  source?: string;
  referrer?: string;
};

const LOCALES = new Set(['pt', 'en', 'es']);

function baseUrl(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, '');
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // Honeypot — silently accept so bots don't learn they were caught.
  if (body.company && body.company.trim() !== '') {
    return NextResponse.json({ ok: true });
  }

  const email = (body.email || '').trim();
  if (!isValidEmail(email) || isDisposable(email.toLowerCase())) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const humanOk = await verifyTurnstile(body.turnstileToken || '', ip);
  if (!humanOk) {
    return NextResponse.json({ error: 'challenge_failed' }, { status: 400 });
  }

  const locale = LOCALES.has(body.locale || '') ? (body.locale as string) : 'pt';
  const source = (body.source || 'organic').slice(0, 120);
  const referrer = body.referrer ? body.referrer.slice(0, 500) : null;
  // Store the stable enum key, not the localized label the user saw.
  const role = normalizeRole(body.role);
  // Tier the signup claimed — only values from PLAN_KEYS are persisted.
  const plan = PLAN_KEYS.includes(body.plan as PlanKey) ? (body.plan as PlanKey) : null;
  const emailNorm = normalizeEmail(email);
  const token = newToken();

  await capture('waitlist_submitted', emailNorm, { locale, source, referrer, role });

  // Dev / preview without a database: succeed so the funnel is testable, and log
  // the confirmation link the email would have carried.
  if (!isDbConfigured()) {
    const confirmUrl = `${baseUrl(req)}/api/confirm?token=${token}`;
    await sendConfirmationEmail(email, locale as 'pt' | 'en' | 'es', confirmUrl);
    console.warn('[waitlist] DATABASE_URL not set — not persisted. token:', token);
    return NextResponse.json({ ok: true, persisted: false });
  }

  const db = getDb();
  const existing = await db
    .select({ id: signups.id, status: signups.status })
    .from(signups)
    .where(eq(signups.emailNorm, emailNorm))
    .limit(1);

  if (existing.length > 0) {
    // Already known — don't leak status; the UI shows "check your inbox".
    return NextResponse.json({ error: 'duplicate' }, { status: 409 });
  }

  await db.insert(signups).values({
    email,
    emailNorm,
    role,
    plan,
    locale,
    source,
    referrer,
    status: 'unconfirmed',
    confirmToken: token
  });

  const confirmUrl = `${baseUrl(req)}/api/confirm?token=${token}`;
  await sendConfirmationEmail(email, locale as 'pt' | 'en' | 'es', confirmUrl);

  return NextResponse.json({ ok: true, persisted: true });
}
