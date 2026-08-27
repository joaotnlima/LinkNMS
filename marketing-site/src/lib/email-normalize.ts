// Canonical email normalization — the single source of truth for the dedupe key
// AND the analytics distinct_id. Pure (no server-only deps) so it is safe to
// import from client components: the client uses it to `posthog.identify()` with
// the exact same id the server captures against, joining the anonymous browsing
// session to the server-side `waitlist_submitted` / `waitlist_verified` events.
//
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
