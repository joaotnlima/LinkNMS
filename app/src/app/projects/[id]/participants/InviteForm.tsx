'use client';

// The PartyInvite form (flow 01 screen 4; PRD-09 O-4): name, email, role, the
// trade when the role is a contractor, and a scope note. Native controls only,
// labels on everything; the role choice is a select with a hint line, never
// colour. After sending, the accept link is shown ONCE to copy and forward.
import { useState } from 'react';

import { ActionForm, type ActionState } from '@/components/ActionForm';
import { INVITE_ROLE_OPTIONS } from '@/lib/v2/participants-view';
import { invitePartyAction } from './actions';

export function InviteForm({
  projectId, specialties, appUrl,
}: {
  projectId: string;
  specialties: ReadonlyArray<{ code: string; name: string; group: string | null }>;
  appUrl: string;
}) {
  const [role, setRole] = useState<string>('contractor');
  const hint = INVITE_ROLE_OPTIONS.find((o) => o.value === role)?.hint;
  const linkOf = (s: ActionState) => `${appUrl}/invitations/${encodeURIComponent(s.token ?? '')}/accept`;
  return (
    <ActionForm
      action={invitePartyAction}
      submitLabel="Send invite"
      pendingLabel="Sending…"
      render={(s) => (s.token ? (
        <div className="imp-ok" role="status">
          <p>Invitation ready for {s.sentTo}. Send them this link — it works once and expires in 14 days:</p>
          <p className="pp-link">{linkOf(s)}</p>
        </div>
      ) : null)}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <div className="pp-form">
        <label className="field">
          <span className="metric-lbl">Name</span>
          <input name="name" type="text" maxLength={200} autoComplete="off" placeholder="Nuno Ferreira — Ferreira Construção" />
        </label>
        <label className="field">
          <span className="metric-lbl">Email</span>
          <input name="email" type="email" required autoComplete="off" placeholder="nuno@ferreiraconstrucao.pt" />
        </label>
        <label className="field">
          <span className="metric-lbl">Role on this build</span>
          <select name="capacity" value={role} onChange={(e) => setRole(e.target.value)}>
            {INVITE_ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {hint && <span className="bh-note">{hint}</span>}
        </label>
        {role === 'contractor' && (
          <label className="field">
            <span className="metric-lbl">Trade (optional — none means general contractor)</span>
            <select name="specialty_code" defaultValue="">
              <option value="">General contractor</option>
              {specialties.map((s) => (
                <option key={s.code} value={s.code}>{s.group ? `${s.group} › ${s.name}` : s.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="metric-lbl">Scope note (optional)</span>
          <textarea name="scope_note" maxLength={1000} rows={3} placeholder="Whole-house build per the signed contract." />
        </label>
      </div>
    </ActionForm>
  );
}
