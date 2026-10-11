// PRD-09 O-3..O-5: role words, the party rows (parties then open invitations)
// and the PartyInvite form. Run: node --test src/lib/v2/participants-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inviteRoleLabel, participantRoleLabel, partyRows, parseInviteForm } from './participants-view.ts';

test('the role is the invitation’s: the trade when named, never "general contractor" for everyone', () => {
  assert.equal(inviteRoleLabel('contractor', 'Electrical'), 'Electrical contractor');
  assert.equal(inviteRoleLabel('contractor', null), 'General contractor');
  assert.equal(inviteRoleLabel('inspection'), 'Inspector');
  assert.equal(participantRoleLabel({ org: { id: 'o', kind: 'household', legal_name: 'A' }, capacity: 'owner', source: 'project' }), 'Owner');
  assert.equal(participantRoleLabel({ org: { id: 'o', kind: 'contractor', legal_name: 'B' }, capacity: 'consultant', source: 'invitation', invite_capacity: 'contractor', specialty_name: 'Plumbing & drainage' }), 'Plumbing & drainage contractor');
});

test('rows: parties (joined, with people) then my open invitations; accepted ones are already parties', () => {
  const rows = partyRows(
    [{ org: { id: 'o1', kind: 'household', legal_name: 'Família Almeida' }, capacity: 'owner', source: 'project', people: [{ person_id: 'x', name: 'Marta' }] }],
    [
      { id: 'i1', email: 'n@f.pt', name: 'Nuno', capacity: 'contractor', status: 'pending', expires_at: '2026-10-25', scope_note: 'Whole house' },
      { id: 'i2', email: 'a@b.pt', capacity: 'inspection', status: 'accepted', expires_at: '2026-10-25' },
      { id: 'i3', email: 'c@d.pt', capacity: 'safety', status: 'expired', expires_at: '2026-10-01' },
    ],
  );
  assert.deepEqual(rows.map((r) => [r.name, r.role, r.state]), [
    ['Família Almeida', 'Owner', 'joined'], ['Nuno', 'General contractor', 'pending'], ['c@d.pt', 'Health & safety', 'expired'],
  ]);
  assert.deepEqual(rows[0].people, ['Marta']);
  assert.equal(rows[1].note, 'Whole house');
});

test('the invite form: email and role required; the trade only travels with a contractor', () => {
  const form = (o) => (k) => o[k] ?? null;
  assert.match(parseInviteForm(form({ email: 'x', capacity: 'contractor' })).error, /email/);
  assert.match(parseInviteForm(form({ email: 'a@b.pt', capacity: 'owner' })).error, /role/);
  assert.deepEqual(parseInviteForm(form({ email: ' A@B.pt ', capacity: 'contractor', specialty_code: 'electrical', name: ' Nuno ', scope_note: '' })).body,
    { email: 'a@b.pt', capacity: 'contractor', name: 'Nuno', specialty_code: 'electrical' });
  assert.deepEqual(parseInviteForm(form({ email: 'a@b.pt', capacity: 'inspection', specialty_code: 'electrical' })).body,
    { email: 'a@b.pt', capacity: 'inspection' });
});
