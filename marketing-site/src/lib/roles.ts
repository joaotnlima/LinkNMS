// Canonical, language-independent role keys. The waitlist stores THESE keys so a
// homeowner is `homeowner` whether they signed up in pt-PT, EN or es-ES — never a
// localized display label like "Dono de obra". Each locale's messages file maps
// the same keys to its own labels under `waitlist.roleOptions` (an ordered
// key → label object), so the dropdown order and copy stay fully localized.
export const ROLE_KEYS = [
  'homeowner',
  'contractor',
  'subcontractor',
  'architect',
  'site_manager',
  'other'
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

const ROLE_SET = new Set<string>(ROLE_KEYS);

// Accept only a known key; anything else (including a stale localized label from
// an older client) is dropped to null rather than persisted verbatim.
export function normalizeRole(role: unknown): RoleKey | null {
  return typeof role === 'string' && ROLE_SET.has(role) ? (role as RoleKey) : null;
}
