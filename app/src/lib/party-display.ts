// How a party is PRINTED — initials, role word, avatar tint (LINA-246).
//
// ── WHY THIS IS A PURE PROJECTION AND NOTHING MORE ───────────────────────────
// The schedule service stores a stage's owner as a party id and nothing else
// (migration 0009, `schedule.stage.assignee_party_id`). It does not know the
// name, does not know the role, and must not: names live in identity, and a
// cross-service name lookup would either couple the two schemas or freeze a copy
// of a name that can change (ADR-0006 §1).
//
// So every owner avatar, every name, every tint on a plan row is derived HERE,
// on the client, from the project members the screen already fetched. A party
// renamed in identity is renamed on the plan the moment the page is read, because
// there was never a second copy to go stale. An id that is not in the directory
// is rendered as an honest gap ("Unknown party"), never as a guess.
//
// ── AVATARS ARE DECORATION, NEVER THE ONLY SIGNAL ────────────────────────────
// The tint follows the party's role (owner / builder), matching the brand-book
// `.av` primitive (brand-book/src/components/PartyInvite.stories.js). The role is
// always spelled out in text beside or behind it — a title, an aria-label, or a
// visible caption — because colour alone never carries a fact (FR9).

import type { Role } from './types';

/** A project member, as every owner surface needs to name one. */
export interface PartyRef {
  partyId: string;
  name: string;
  role: string | null;
}

/** The honest gap for an id the directory does not hold. */
export const UNKNOWN_PARTY = 'Unknown party';

/**
 * Up to two letters from a display name, for the avatar circle.
 *
 * First + last initial, so "Nuno Ferreira" reads NF and a mononym reads its one
 * letter rather than being padded out. An empty or whitespace-only name gives
 * '?' — the same honest gap `UNKNOWN_PARTY` is in words.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * The role as the parties call themselves.
 *
 * `subcontractor` is "Trade" and NOT folded into the GC: attributing a specialty
 * sub's work to the contractor would be an invented attribution on a record whose
 * whole promise is that it does not invent. Anything unrecognised falls back to
 * the neutral "Party" rather than to the owner.
 */
export function roleWord(role: string | null | undefined): string {
  if (role === 'owner') return 'Owner';
  if (role === 'counterparty') return 'General contractor';
  if (role === 'subcontractor') return 'Trade';
  return 'Party';
}

/**
 * Which brand tint an avatar wears — the two sides of the record.
 *
 * The owner is one side; everyone doing the work (GC and specialty subs alike)
 * is the other. This is a two-colour palette on purpose: it answers "whose side
 * of the table" at a glance, and the precise role is the text beside it.
 */
export function avatarTone(role: string | null | undefined): 'owner' | 'builder' {
  return role === 'owner' ? 'owner' : 'builder';
}

/** partyId → the member, for naming an owner without re-scanning the list. */
export function partyIndex(parties: PartyRef[]): Map<string, PartyRef> {
  return new Map(parties.map((p) => [p.partyId, p]));
}

/**
 * The member an id names, or null.
 *
 * Null is a real answer with two real causes: the stage has no owner
 * (`assigneePartyId` is null — "Unassigned"), or it names a party this project
 * no longer holds. Both render as the absence of an avatar rather than as a
 * placeholder person.
 */
export function partyOf(
  index: Map<string, PartyRef>, partyId: string | null | undefined,
): PartyRef | null {
  if (!partyId) return null;
  return index.get(partyId) ?? { partyId, name: UNKNOWN_PARTY, role: null };
}

/** A member's role narrowed to the portal's vocabulary, for callers that need it. */
export function asRole(role: string | null | undefined): Role {
  return role === 'owner' ? 'owner' : role === 'subcontractor' ? 'subcontractor' : 'counterparty';
}
