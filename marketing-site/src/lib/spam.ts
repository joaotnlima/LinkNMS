// Layered anti-spam, all free: normalized-email dedupe key, honeypot, a small
// disposable-domain blocklist, and optional Cloudflare Turnstile verification.

// A minimal, high-signal disposable-domain blocklist. Kept short on purpose —
// the DB unique index and Turnstile carry the real load.
const DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'trashmail.com',
  'yopmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'throwawaymail.com',
  'fakeinbox.com'
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

// Normalize for dedupe: lowercase + trim, and for Gmail strip dots and the
// +tag from the local part (all route to the same inbox).
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  local = local.split('+')[0];
  return `${local}@${domain}`;
}

export function isDisposable(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return DISPOSABLE.has(domain);
}

// Verify a Turnstile token against Cloudflare's siteverify. When no secret is
// configured (e.g. local dev) verification is skipped — the honeypot and DB
// dedupe still apply.
export async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured → don't block
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

// Short, unguessable, URL-safe single-use token (uses Web Crypto — Edge-safe).
export function newToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
