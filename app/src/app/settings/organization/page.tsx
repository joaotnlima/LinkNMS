// /settings/organization — the company: members, roles and seats (PRD-12 N-9,
// to-be/16, D-34 as amended by D-38). Invitations, role changes and removals go
// to Clerk through the identity module; this page only shows what the API
// answers and offers the roles `Me.assignable_roles` lists. Managing members
// needs `org:members:manage`; seats come from billing usage when the viewer may
// read it. The public company profile is PRD-03 (link only).
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import { getMeSettings, getUsage, listOrgMembers } from '@/lib/v2/settings';
import { ORG_KIND_LABEL, can, entitlementRows, roleLabel } from '@/lib/v2/settings-view';
import { sessionState } from '@/server/session';

import { changeRoleAction, inviteMemberAction, removeMemberAction } from '../actions';
import { SettingsFrame } from '../SettingsFrame';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Organisation settings · LinkNMS' };

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/settings/organization');
  if (state.kind === 'unseated') redirect('/no-access');

  const [{ saved, error }, profile, me] = await Promise.all([searchParams, getViewerProfile(), getMeSettings()]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const org = me?.active_org ?? null;
  const canManage = can(me, 'org:members:manage');
  const [members, usage] = await Promise.all([
    org && canManage ? listOrgMembers(org.id) : Promise.resolve(null),
    org && can(me, 'org:billing:manage') ? getUsage() : Promise.resolve(null),
  ]);
  const seats = entitlementRows(usage).find((r) => r.key === 'seats') ?? null;
  const roles = me?.assignable_roles ?? [];

  return (
    <SettingsFrame user={user} tab="organization" saved={saved} error={error}>
      {!org ? (
        <section className="set-card"><h2>No organisation selected</h2>
          <p>Pick or create your company or household first — settings apply to the organisation you act for.</p>
        </section>
      ) : (
        <>
          <section className="set-card" aria-labelledby="set-org">
            <h2 id="set-org">{org.legal_name}</h2>
            <dl className="set-kv">
              <dt>Kind</dt><dd>{ORG_KIND_LABEL[org.kind] ?? org.kind}</dd>
              <dt>Your role</dt><dd>{roleLabel(me?.org_role)}</dd>
              {seats ? (<><dt>Seats</dt>
                <dd className={`set-meter${seats.full ? ' is-full' : ''}`}>{seats.used} of {seats.limit} used</dd></>) : null}
            </dl>
            <p><Link className="set-link" href="/settings/organization/profile">Public company profile</Link></p>
          </section>

          <section className="set-card" aria-labelledby="set-members">
            <h2 id="set-members">Members</h2>
            {!canManage || members == null ? (
              <p>Only an admin of {org.legal_name} manages members and their roles.</p>
            ) : (
              <>
                <p>Roles decide what each person may do for the company; what they see on a build follows its contracts.</p>
                <table className="set-table">
                  <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}<span className="set-sub">{m.email}</span></td>
                        <td>
                          <form action={changeRoleAction} className="set-inline">
                            <input type="hidden" name="org_id" value={org.id} />
                            <input type="hidden" name="person_id" value={m.id} />
                            <select name="org_role" defaultValue={m.org_role} aria-label={`Role of ${m.name}`}>
                              {(roles.includes(m.org_role) ? roles : [m.org_role, ...roles]).map((r) =>
                                <option key={r} value={r}>{roleLabel(r)}</option>)}
                            </select>
                            <button type="submit" className="set-btn is-quiet">Change</button>
                          </form>
                        </td>
                        <td>
                          {m.id !== me?.person.id ? (
                            <form action={removeMemberAction} className="set-row-actions">
                              <input type="hidden" name="org_id" value={org.id} />
                              <input type="hidden" name="person_id" value={m.id} />
                              <button type="submit" className="set-btn is-danger">Remove</button>
                            </form>
                          ) : <span className="set-sub">You</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          {canManage && members != null ? (
            <section className="set-card" aria-labelledby="set-invite">
              <h2 id="set-invite">Invite a colleague</h2>
              <p>They receive an e-mail to join {org.legal_name} with the role you choose.</p>
              <form action={inviteMemberAction} className="set-inline">
                <input type="hidden" name="org_id" value={org.id} />
                <input type="email" name="email" required placeholder="name@company.pt" aria-label="E-mail" />
                <select name="org_role" defaultValue={roles.includes('member') ? 'member' : roles[0]} aria-label="Role">
                  {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
                <button type="submit" className="set-btn">Send invitation</button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </SettingsFrame>
  );
}
