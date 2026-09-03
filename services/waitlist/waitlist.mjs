// Waitlist service — the D-4 email capture + D-2 welcome trigger (LINA-127;
// Onboarding Plan v4 Phase 1).
//
// This is the backend's authoritative waitlist: the Portal's POST /api/waitlist
// target. It owns the data-integrity rules a source-of-truth table must hold:
//   - email is validated and normalized BEFORE it is considered; the dedupe key
//     (email_norm) is UNIQUE in the database, not just checked here, so a
//     duplicate is impossible even if the service is bypassed;
//   - a duplicate signup is a 409, never a second row;
//   - status opens `waitlisted` (the plan's lifecycle); it flips to `active` only
//     on first login (Phase 2) — nothing in this Phase 1 write path sets it;
//   - signup_order is the DB-assigned monotonic counter the go-date batch selects
//     "the first 10" by — never a client-supplied value.
//
// The D-2 welcome email is triggered here through the Email port, and it may
// DEGRADE without failing the signup: a missed welcome email is a lost
// follow-up, not a security event (see ports.mjs). The signup commits either way.
import { randomUUID } from 'node:crypto';
import { DomainError } from './ports.mjs';

const now = () => new Date().toISOString();

// Email validity + disposable-domain guard (kept small and high-signal; the DB
// UNIQUE index and the spam layer carry the real load). Mirrors the rules the
// marketing-site form already enforces (marketing-site/src/lib/spam.ts) so the
// Portal's capture accepts the same set of emails.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'trashmail.com', 'yopmail.com', 'sharklasers.com',
  'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
]);

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 254;
}

export function isDisposable(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return DISPOSABLE.has(email.slice(at + 1).toLowerCase());
}

// Normalize for the dedupe key: lowercased, trimmed, canonical domain. Kept in
// the service (not the client) so the authoritative dedupe key can never drift
// from what the database enforces.
export function normalizeEmail(email) {
  // Trim whitespace (including surrounding spaces a user pastes) and lowercase —
  // the canonical dedupe key. Kept in the service so it can never drift from the
  // UNIQUE(email_norm) the database enforces.
  return String(email).trim().toLowerCase();
}

const LOCALES = new Set(['pt', 'en', 'es']);

// A welcome email is best-effort: it must never turn a committed signup into a
// 500, so a throw or a false from the Email port is absorbed here.
export function createWaitlistService({ store, email, clock = now }) {
  if (!store || !email) {
    throw new Error('createWaitlistService requires { store, email } ports');
  }

  // POST /api/waitlist — the D-4 email capture.
  //   input: { email, locale?, role?, source?, referrer? }  (role/source/referrer
  //   are kept for parity with the form; neither participates in dedupe/order.)
  async function subscribe(input) {
    const { email: rawEmail, locale, role, source, referrer } = input ?? {};

    // 1. Validate before we even look at storage. Invalid or disposable → 400.
    const trimmed = String(rawEmail || '').trim();
    if (!isValidEmail(trimmed) || isDisposable(trimmed)) {
      throw new DomainError(400, 'invalid_email', 'a valid, non-disposable email is required');
    }
    if (locale != null && !LOCALES.has(locale)) {
      throw new DomainError(400, 'invalid_locale', "locale must be one of 'pt', 'en', 'es'");
    }

    const emailNorm = normalizeEmail(trimmed);
    const createdAt = clock();
    const id = randomUUID();

    // 2/3. Dedupe + store: UNIQUE(email_norm) is the backstop; a duplicate is a
    // 409 `duplicate` (the frontend renders a distinct "check your inbox" state).
    let signedUp = null;
    await store.transaction(async (tx) => {
      const result = await store.insert(tx, {
        id,
        email: trimmed,
        email_norm: emailNorm,
        status: 'waitlisted',
        created_at: createdAt,
      });
      if (result.duplicate) {
        throw new DomainError(409, 'duplicate', 'this email is already on the waitlist');
      }
      signedUp = result.row;
    });

    // 4. Trigger the D-2 welcome email — best-effort, after the signup commits.
    const emailSent = await email.sendWelcome(trimmed, {
      locale: locale || 'en',
      url: (input && input.confirmUrl) ?? null,
    });

    // 5. The response the frontend form reads. Deliberately minimal and
    // non-identifying: it never leaks whether a prior signup exists.
    const view = {
      id: signedUp.id,
      email: signedUp.email,
      status: signedUp.status,
      signupOrder: signedUp.signup_order,
      createdAt: signedUp.created_at,
    };
    return { ...view, welcomeEmailSent: emailSent };
  }

  return { subscribe };
}

export { DomainError };
