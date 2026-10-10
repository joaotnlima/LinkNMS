// Directory domain — the name an UNCLAIMED profile gets when it is seeded from
// an RFP invitation by e-mail (PRD-04 X-2). Pure.
//
// One unclaimed profile per e-mail ADDRESS (PRD-04 §7 item 3, default kept
// from PRD-03: addresses fragment a company, domains would merge colleagues
// of different firms on a shared host). The profile is public, so its name
// must never expose a person: it is the company's DOMAIN, prettified. An
// address on a personal-mail host (gmail, hotmail, sapo…) carries no company
// name at all — no profile is seeded for it (a default, flagged in PRD-04).

export const PERSONAL_MAIL_DOMAINS = Object.freeze(new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.pt', 'outlook.com', 'outlook.pt', 'live.com',
  'live.com.pt', 'msn.com', 'yahoo.com', 'yahoo.com.br', 'yahoo.es', 'icloud.com', 'me.com', 'mac.com',
  'sapo.pt', 'mail.pt', 'iol.pt', 'clix.pt', 'netcabo.pt', 'aeiou.pt', 'gmx.com', 'gmx.net', 'gmx.pt',
  'protonmail.com', 'proton.me', 'aol.com', 'zoho.com', 'yandex.com', 'mail.com',
]));

// Second-level labels that are part of a public suffix (construcoes.com.pt).
const SUFFIX_LABELS = new Set(['com', 'org', 'net', 'gov', 'edu', 'co', 'pt', 'br', 'uk', 'es', 'fr']);

/**
 * The display name of an unclaimed profile for `email`, or null when the
 * address names no company (personal-mail host, malformed).
 *   obra@empreiteiro-amigo.pt        → "Empreiteiro Amigo"
 *   geral@construcoes-silva.com.pt   → "Construcoes Silva"
 */
export function unclaimedNameFor(email) {
  const at = String(email ?? '').trim().toLowerCase().split('@');
  if (at.length !== 2 || !at[0] || !at[1]) return null;
  const domain = at[1];
  if (PERSONAL_MAIL_DOMAINS.has(domain)) return null;
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  labels.pop(); // the top-level domain
  while (labels.length > 1 && SUFFIX_LABELS.has(labels[labels.length - 1])) labels.pop();
  const base = labels[labels.length - 1];
  const words = base.split(/[-_]+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 120);
}
