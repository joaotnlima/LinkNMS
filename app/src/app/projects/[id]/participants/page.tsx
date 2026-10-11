// Participants — `/projects/{id}/participants` (PRD-09 O-3, O-4; flows A3–A4;
// to-be/20: absorbs v1 `/invite`). Every party on the build with its role, its
// people and its state, then the invitations my organisation sent that are
// still open — and the PartyInvite. Who may invite is the server's call (the
// owner or the prime contractor); a refusal comes back as a sentence.
//
// Three reads in one round; the role words come from participants-view.ts.
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getProjectOverview } from '@/lib/v2/build-home';
import { listParticipants, listMyInvitations } from '@/lib/v2/participants';
import { partyRows } from '@/lib/v2/participants-view';
import { listSpecialties } from '@/lib/v2/directory';
import { InviteForm } from './InviteForm';
import '../build-home.css';

export const dynamic = 'force-dynamic';

export default async function ParticipantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/participants`);

  const [overview, participants, invitations, taxonomy] = await Promise.all([
    getProjectOverview(id), listParticipants(id), listMyInvitations(id), listSpecialties().catch(() => []),
  ]);
  const name = overview?.project.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);
  const rows = partyRows(participants, invitations);
  const groups = new Map(taxonomy.filter((s) => !s.parent_code).map((s) => [s.code, s.name_en]));
  const specialties = taxonomy.map((s) => ({ code: s.code, name: s.name_en, group: s.parent_code ? groups.get(s.parent_code) ?? null : null }));
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="participants">
      <main className="m14">
        <header className="m14-head">
          <h1 className="m14-title">Participants</h1>
          <p className="bh-note">
            Everyone on {name}. An invited contractor reads the build; its part of the plan and its prices come with
            its contract.
          </p>
        </header>

        {!overview ? (
          <p className="bh-note">This build could not be loaded for you.</p>
        ) : (
          <table className="pp-table">
            <thead>
              <tr><th scope="col">Organisation</th><th scope="col">Role on the build</th><th scope="col">People</th><th scope="col">State</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}{r.note && <div className="bh-note">{r.note}</div>}</td>
                  <td>{r.role}</td>
                  <td>{r.people.length ? r.people.join(', ') : '—'}</td>
                  <td><span className={`pp-state ${r.state}`}>{r.stateLabel}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <section className="bh-sec" aria-labelledby="pp-invite-t">
          <h2 id="pp-invite-t" className="bh-h">Invite someone</h2>
          <InviteForm projectId={id} specialties={specialties} appUrl={appUrl} />
        </section>
      </main>
    </PortalShell>
  );
}
