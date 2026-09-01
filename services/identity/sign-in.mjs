// Magic-link sign-in service (LINA-76; ADR-0007) — the "proof" half of the
// session. It mints a single-use, short-lived, hashed-at-rest token, emails the
// raw token once, and later consumes it to establish WHO is signing in. The
// cookie half (services/identity/session.mjs) is untouched; this is what proves
// a person controls the email before session.mjs mints their cookie.
//
// Written against the sign-in store PORT and an injected sender, so it runs and
// is adversarially tested with zero I/O (./sign-in.test.mjs) and the same logic
// serves Postgres in production (./sign-in-store.mjs + ../email/sender.mjs).
//
// THE invariants (ADR-0007):
//   §1  the DB stores sha256(raw) only; the raw token is returned/emailed once
//       and never persisted or logged; consume is a single atomic conditional
//       update, so two concurrent consumes of one link yield exactly one session.
//   §4  /request ALWAYS resolves the same (202 {}) whether or not the email is a
//       known party — no membership oracle; rate-limited per email AND per IP.
//   §4  every consume failure (expired / used / unknown / malformed) is the same
//       400 invalid_token — no distinguishing which.
//   §5  if email delivery is unconfigured, /request FAILS CLOSED (503). It never
//       falls back to logging or returning the link.

import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { IdentityError, badRequest } from './errors.mjs';
import { sendEmail, isEmailConfigured } from '../email/sender.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// 32 bytes base64url — the raw token, generated once, never stored (only its hash).
const defaultIds = { uuid: () => randomUUID(), token: () => randomBytes(32).toString('base64url') };
const defaultClock = { now: () => new Date() };

// TTL 15 minutes (ADR-0007 §1): long enough to switch to an email client, short
// enough that a link sitting in a mailbox is not a standing credential.
export const SIGN_IN_TTL_MS = 15 * 60 * 1000;
// 5 requests / 15 min, per email and per IP (ADR-0007 §4, suggested).
export const RATE_DEFAULT = { max: 5, windowMs: 15 * 60 * 1000 };

// Every consume failure is indistinguishable (ADR-0007 §4). One error, one copy.
const invalidToken = () =>
  new IdentityError('invalid_token', 400, 'this link is no longer valid — request a new one');

const emailUnconfigured = () =>
  new IdentityError('email_unconfigured', 503, 'email delivery is not configured');

// Shallow, deliberately: an address is a lookup key in R0, not a place to
// litigate RFC 5322. Requires an `@` and a dotted domain so we do not fire a
// send at obvious garbage. Lower-cased so `Ana@x.com` and `ana@x.com` are one.
function normalizeEmail(email) {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return null;
  return clean;
}

const cleanName = (n) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 200) : null);

// Only ever honour a same-origin relative path as the post-sign-in destination,
// so a crafted `next` cannot turn the callback into an open redirect. Anything
// else (absolute URL, protocol-relative `//host`, non-path) falls back to `/`.
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function buildLink(baseUrl, rawToken, next) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const q = new URLSearchParams({ token: rawToken });
  const nx = safeNext(next);
  if (nx !== '/') q.set('next', nx);
  return `${base}/auth/callback?${q.toString()}`;
}

function signInEmailHtml(link) {
  // Minimal, self-contained, inline-styled. No tracking, no external assets.
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;background:#f4f3f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0b0b0b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fcfcfb;border:1px solid #dcdbd7;border-radius:12px;padding:32px">
      <tr><td style="font-weight:700;font-size:18px;letter-spacing:-.01em;padding-bottom:8px">LinkNMS <span style="color:#9a9a9a;font-weight:500;font-size:13px">Trust built-in.</span></td></tr>
      <tr><td style="font-size:20px;font-weight:600;padding:16px 0 8px">Sign in to LinkNMS</td></tr>
      <tr><td style="font-size:15px;line-height:1.5;color:#5b5b58;padding-bottom:24px">Click the button below to sign in. This link works once and expires in 15 minutes.</td></tr>
      <tr><td><a href="${link}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:36px">Sign in</a></td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#9a9a9a;padding-top:28px;border-top:1px dashed #dcdbd7">If you didn't ask to sign in, ignore this email — the link does nothing until it is opened.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/**
 * @param {Object} deps
 * @param {ReturnType<import('./sign-in-store.mjs').createMemorySignInStore>} deps.store
 * @param {{ findOrCreateByEmail(x):Promise<any>, getById(id):Promise<any> }} deps.parties
 * @param {{ send(msg,opts):Promise<any>, isConfigured(env):boolean }} [deps.sender]
 * @param {{ uuid():string, token():string }} [deps.ids]
 * @param {{ now():Date }} [deps.clock]
 * @param {number} [deps.ttlMs]
 * @param {{ max:number, windowMs:number }} [deps.rate]
 */
export function createSignInService({
  store,
  parties,
  sender = { send: sendEmail, isConfigured: isEmailConfigured },
  ids = defaultIds,
  clock = defaultClock,
  ttlMs = SIGN_IN_TTL_MS,
  rate = RATE_DEFAULT,
  env = process.env,
}) {
  if (!store) throw new Error('sign-in service requires a store');
  // Refuse to boot against a store with no seat gate rather than discovering it
  // as a TypeError on the first request. A sign-in path that silently lost its
  // allowlist is open registration, so this is a construction-time hard stop.
  if (typeof store.hasActiveSeat !== 'function') {
    throw new Error('sign-in service requires a store with hasActiveSeat (ADR-0008 seat gate)');
  }
  if (!parties?.findOrCreateByEmail) throw new Error('sign-in service requires a parties port');

  /**
   * POST /sessions/request. Mint + email a magic link. ALWAYS resolves the same
   * regardless of whether `email` is a known party (§4). The ONLY non-202 is a
   * 503 when email delivery is unconfigured — uniform, and it leaks nothing.
   * @param {{ email?:string, displayName?:string, ip?:string|null, baseUrl:string, next?:string }} input
   */
  async function request({ email, displayName, ip = null, baseUrl, next }) {
    // Fail closed BEFORE the address is even examined, so an unconfigured deploy
    // 503s uniformly rather than 202-ing malformed addresses into a silent void.
    if (!sender.isConfigured(env)) throw emailUnconfigured();

    const clean = normalizeEmail(email);
    // A malformed address is an indistinguishable no-op: still 202, nothing sent.
    if (!clean) return;

    // THE SEAT GATE (ADR-0008). Without it, `consume` ends in
    // findOrCreateByEmail — so proving control of ANY address on the internet
    // mints a party, i.e. open registration on a trust product. A link is minted
    // and mailed only to an address that holds an active seat.
    //
    // Note WHERE this sits: after the malformed-address check, before anything
    // is written or sent, and it declines exactly like every other decline — the
    // route still answers 202 {}. A seated and an unseated address are
    // indistinguishable from outside, so the allowlist is not a membership
    // oracle either; ADR-0007 §4 survives intact.
    //
    // It is deliberately CHEAPER than the rate-limit check (one indexed point
    // lookup vs two COUNTs), so the common hostile case — a stranger's address —
    // costs the least. The trade-off is that an unseated request inserts no row
    // and therefore does not accrue against the per-IP counter; that is
    // acceptable because such a request writes nothing and sends nothing, so the
    // only thing it can exhaust is our own request budget, not a user's inbox.
    if (!(await store.hasActiveSeat(clean))) return;

    const now = clock.now();
    const since = new Date(now.getTime() - rate.windowMs).toISOString();
    const [byEmail, byIp] = await Promise.all([
      store.countRecentByEmail(clean, since),
      store.countRecentByIp(ip, since),
    ]);
    // Over the limit → silently drop (still 202): the counter lives in Postgres
    // because a serverless deploy has no shared memory (§4).
    if (byEmail >= rate.max || byIp >= rate.max) return;

    const raw = ids.token();
    await store.insertToken({
      id: ids.uuid(),
      email: clean,
      displayName: cleanName(displayName),
      tokenHash: sha256Hex(raw), // only the hash is persisted
      requestIp: ip,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });

    // The raw token leaves the process ONLY inside the email body — never a log
    // line, never the HTTP response. A send failure throws (mapped to 502).
    await sender.send(
      { to: clean, subject: 'Your LinkNMS sign-in link', html: signInEmailHtml(buildLink(baseUrl, raw, next)) },
      { env },
    );
  }

  /**
   * POST /sessions/consume. Atomically spend the token, then find-or-create the
   * party. Returns `{ party }` for the route to mint the session cookie via the
   * existing mintSession — so the response shape matches POST /sessions today.
   * Every failure is the same 400 invalid_token (§4).
   * @param {{ token?:string }} input
   * @returns {Promise<{ party: any }>}
   */
  async function consume({ token }) {
    if (!token || typeof token !== 'string') throw invalidToken();
    const row = await store.consumeToken(sha256Hex(token), clock.now().toISOString());
    if (!row) throw invalidToken(); // expired / already used / unknown — one answer

    // find-or-create is an upsert on UNIQUE(email): a first-time signer becomes a
    // party here, a returning one resolves to their existing row. Role defaults
    // to contractor; a homeowner who creates a project is unaffected (the acting
    // role is a per-project membership, never a global party attribute — ADR-0004).
    const party = await parties.findOrCreateByEmail({
      email: row.email,
      displayName: row.displayName ?? undefined,
      role: 'contractor',
    });
    return { party };
  }

  return { request, consume };
}

// Re-exported for the route layer and tests that assert redirect safety.
export { normalizeEmail, buildLink };
