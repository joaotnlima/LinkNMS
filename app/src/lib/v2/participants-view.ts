// Pure v2-wire → view transforms for `/projects/{id}/participants` (PRD-09
// O-3..O-5) and the invite landing's role line. Who may invite and who is on
// the build are the server's answers; this only names roles and validates the
// PartyInvite form before the round trip (the server validates again).

export type InviteCapacity = 'contractor' | 'design' | 'inspection' | 'safety' | 'other';

export interface V2Participant {
  org: { id: string; kind: string; legal_name: string };
  capacity: 'owner' | 'prime_contractor' | 'direct_contractor' | 'subcontractor' | 'consultant';
  source: 'project' | 'contract' | 'invitation';
  contract_id?: string;
  invite_capacity?: InviteCapacity;
  specialty_code?: string;
  specialty_name?: string;
  people?: Array<{ person_id: string; name: string }>;
}

export interface V2ProjectInvitation {
  id: string;
  email: string;
  name?: string;
  capacity: InviteCapacity;
  specialty_code?: string;
  specialty_name?: string;
  scope_note?: string;
  created_at?: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  token?: string;
}

/** The invite's role as a person reads it: the trade when one is named. */
export function inviteRoleLabel(capacity: string, specialtyName?: string | null): string {
  switch (capacity) {
    case 'contractor': return specialtyName ? `${specialtyName} contractor` : 'General contractor';
    case 'design': return 'Design consultant';
    case 'inspection': return 'Inspector';
    case 'safety': return 'Health & safety';
    default: return specialtyName ?? 'Consultant';
  }
}

/** A party's role on the build. */
export function participantRoleLabel(p: V2Participant): string {
  switch (p.capacity) {
    case 'owner': return 'Owner';
    case 'prime_contractor': return 'General contractor · under contract';
    case 'direct_contractor': return `${p.specialty_name ?? 'Specialty'} contractor · under contract`;
    case 'subcontractor': return 'Subcontractor · under contract';
    default:
      return p.source === 'invitation' ? inviteRoleLabel(p.invite_capacity ?? 'other', p.specialty_name) : 'Consultant';
  }
}

export interface PartyRow {
  key: string;
  name: string;
  role: string;
  people: string[];
  state: 'joined' | 'pending' | 'expired' | 'revoked';
  stateLabel: string;
  note?: string;
}

const STATE_LABEL: Record<PartyRow['state'], string> = {
  joined: 'On the build', pending: 'Invite sent — awaiting reply', expired: 'Invite expired', revoked: 'Invite withdrawn',
};

/**
 * Parties on the build, then the invitations my organisation sent that are
 * not yet taken up (accepted ones are already parties). One row each.
 */
export function partyRows(participants: V2Participant[], invitations: V2ProjectInvitation[]): PartyRow[] {
  const seen = new Set<string>();
  const rows: PartyRow[] = [];
  for (const p of participants) {
    const key = `${p.org.id}:${p.capacity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key, name: p.org.legal_name, role: participantRoleLabel(p),
      people: (p.people ?? []).map((x) => x.name), state: 'joined', stateLabel: STATE_LABEL.joined,
    });
  }
  for (const i of invitations) {
    if (i.status === 'accepted') continue;
    rows.push({
      key: `inv:${i.id}`, name: i.name || i.email, role: inviteRoleLabel(i.capacity, i.specialty_name),
      people: i.name ? [i.email] : [], state: i.status, stateLabel: STATE_LABEL[i.status], note: i.scope_note,
    });
  }
  return rows;
}

export const INVITE_ROLE_OPTIONS: ReadonlyArray<{ value: InviteCapacity; label: string; hint: string }> = Object.freeze([
  { value: 'contractor', label: 'Contractor', hint: 'A general contractor, or a specialty when you pick its trade. Their part of the plan comes with their contract.' },
  { value: 'design', label: 'Design consultant', hint: 'Architect or engineer following the build' },
  { value: 'inspection', label: 'Inspector', hint: 'Verifies completed work and raises non-conformities' },
  { value: 'safety', label: 'Health & safety', hint: 'Inspections and safety non-conformities' },
  { value: 'other', label: 'Other', hint: 'Someone who follows the build' },
]);

export interface InviteBody {
  email: string;
  capacity: InviteCapacity;
  name?: string;
  specialty_code?: string;
  scope_note?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The PartyInvite form → the wire body, or the sentence to show. */
export function parseInviteForm(get: (k: string) => string | null): { body?: InviteBody; error?: string } {
  const email = (get('email') ?? '').trim().toLowerCase();
  const capacity = (get('capacity') ?? '') as InviteCapacity;
  const name = (get('name') ?? '').trim();
  const specialty = (get('specialty_code') ?? '').trim();
  const note = (get('scope_note') ?? '').trim();
  if (!EMAIL.test(email)) return { error: 'Enter the email the invitation goes to.' };
  if (!INVITE_ROLE_OPTIONS.some((o) => o.value === capacity)) return { error: 'Choose their role on this build.' };
  if (name.length > 200) return { error: 'The name is at most 200 characters.' };
  if (note.length > 1000) return { error: 'The scope note is at most 1000 characters.' };
  return {
    body: {
      email, capacity,
      ...(name ? { name } : {}),
      ...(specialty && capacity === 'contractor' ? { specialty_code: specialty } : {}),
      ...(note ? { scope_note: note } : {}),
    },
  };
}
