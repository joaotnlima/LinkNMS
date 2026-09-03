// The client IP, derived from a hop the client cannot forge (LINA-79).
//
// ── THE BUG THIS REPLACES ────────────────────────────────────────────────────
// `POST /sessions/request` (the magic-link route, since deleted in LINA-124)
// took the LEFT-MOST `x-forwarded-for` hop for its per-IP rate limit. That entry is whatever the client sent: a proxy APPENDS the
// address it observed, so a request arriving with `x-forwarded-for: 9.9.9.9`
// reaches us as `9.9.9.9, <real client>`. An attacker rotating a fresh fake
// left-most value per request gets a fresh counter every time and the per-IP
// limit never bites.
//
// That is worse than having no per-IP limit at all: ADR-0007 §4 says the endpoint
// is rate limited per email AND per IP, and a limit that reads as protection
// while providing none is exactly the kind of thing nobody re-checks. (The
// per-email limit is the one that actually protects a given person's inbox, and
// it was never affected — it counts a normalised address in Postgres.)
//
// ── WHAT WE TRUST INSTEAD ────────────────────────────────────────────────────
// Only hops our own infrastructure wrote, in descending order of trust:
//
//   1. `x-vercel-forwarded-for` — set by Vercel's proxy on every request; a
//      client-supplied copy is overwritten, not appended to.
//   2. `x-real-ip` — likewise set by Vercel, single-valued.
//   3. `x-forwarded-for`, RIGHT-most entry — the hop the last proxy appended.
//      Everything to its left is client-controlled and deliberately ignored.
//
// Right-most, not left-most, is the whole point: the left-most is "the client's
// claim about itself", the right-most is "what our proxy saw".
//
// Running WITHOUT a proxy in front (a bare `next start`, a local dev server),
// every one of these headers is client-controlled and none of them is
// trustworthy. That is fine here and deliberately not special-cased: the caller
// treats the result as best-effort, a `null` simply means the per-IP counter is
// skipped, and the per-email limit still holds. This function's contract is
// "the most trustworthy hop available", not "a proven client identity" — nothing
// security-critical may key off it.

// A conservative shape check. The value is attacker-influenced in the untrusted
// case and lands in an indexed Postgres `text` column, so junk must not be
// counted as an "IP" — two different junk strings would otherwise each get their
// own rate-limit bucket, which is the bug all over again.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
// Loose but bounded: hex groups and colons only, at least one colon, no runaway
// length. Full IPv6 grammar is not worth re-implementing for a rate-limit key.
const IPV6 = /^[0-9a-f:]{2,45}$/i;

function normaliseIp(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (!v) return null;
  // `[::1]:443` / `[::1]` — bracketed IPv6, optionally with a port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1];
  // `1.2.3.4:443` — IPv4 with a port. A bare IPv6 has many colons; only strip
  // when there is exactly one, so `::1` survives.
  else if (v.split(':').length === 2) v = v.split(':')[0];

  if (IPV4.test(v)) return v;
  if (v.includes(':') && IPV6.test(v)) return v.toLowerCase();
  return null;
}

/** The right-most entry of a comma-separated forwarded-for list. */
function rightmost(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const ip = normaliseIp(parts[i]);
    if (ip) return ip;
  }
  return null;
}

/**
 * @param {Headers|{ get(name:string): string|null }} headers
 * @returns {string|null} the most trustworthy client IP available, or null.
 */
export function clientIpOf(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  return (
    rightmost(get('x-vercel-forwarded-for'))
    ?? normaliseIp(get('x-real-ip'))
    ?? rightmost(get('x-forwarded-for'))
  );
}
