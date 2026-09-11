// PartyAvatar / TradeChip — how a stage says who owns it (LINA-246).
//
// Brand-book: `.av` in PartyInvite (brand-book/src/components/PartyInvite.stories.js)
// — the initials circle, tinted owner-blue or builder-orange. This is that
// primitive, componentised for the plan surfaces, plus the specialty chip that
// rides beside it. Both are documented as stories in
// brand-book/src/components/StageOwner.stories.js so the pattern has one home.
//
// NOTHING HERE IS A PERMISSION. An avatar on a stage says who is expected to do
// it. It grants no read and no write: the assignee sees and edits exactly what
// their membership role already allowed (ADR-0017 annex 3). The screens that draw
// it must not gate anything on it, and none of them do.
//
// COLOUR IS NEVER THE ONLY SIGNAL (FR9): the tint says which side of the table,
// and the role is always spelled out — in the accessible name here, and in the
// caption beside it on every surface that has room for one.

import { avatarTone, initials, roleWord, type PartyRef } from '@/lib/party-display';
import './party-avatar.css';

export function PartyAvatar({
  party, size = 'md',
}: {
  party: PartyRef;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={`pav pav--${size} pav--${avatarTone(party.role)}`}
      // The accessible name, not aria-hidden: on a plan row this circle IS the
      // statement of who owns the stage, so a screen reader has to hear it.
      role="img"
      aria-label={`${party.name} · ${roleWord(party.role)}`}
      title={`${party.name} · ${roleWord(party.role)}`}
    >
      {initials(party.name)}
    </span>
  );
}

/**
 * The "no owner" state, drawn as an absence rather than as a person.
 *
 * A grey circle with a person-shaped glyph would read as somebody. An unassigned
 * stage has nobody on it, and the plan should say so in the one word that is
 * true of it.
 */
export function UnassignedAvatar({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={`pav pav--${size} pav--none`}
      role="img"
      aria-label="Unassigned"
      title="Unassigned"
    >
      —
    </span>
  );
}

/**
 * The specialty label as a chip ("Electrical", "Roofing").
 *
 * Free text from the plan — it is whatever the author or the imported
 * spreadsheet called the trade, not a controlled vocabulary. Rendered verbatim:
 * normalising "elec" to "Electrical" would be the record editing what it was
 * told.
 */
export function TradeChip({ trade }: { trade: string }) {
  const label = trade.trim();
  if (!label) return null;
  return <span className="ptrade" title={`Trade · ${label}`}>{label}</span>;
}
