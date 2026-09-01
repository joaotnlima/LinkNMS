// FR1, second half — invite the GC (LINA-57).
//
// R0 delivers the invitation OUT OF BAND: ADR-0001 specifies a magic link, but
// the email integration does not exist yet, so the owner copies a single-use
// code and sends it however they already talk to their GC. That is stated on the
// screen rather than hidden, because an invite the owner believes was emailed
// and was not is a silent dead end.
//
// ⚠️ The raw code is shown EXACTLY ONCE and is never stored (only its SHA-256
// is). Re-rendering this page cannot show it again — hence the explicit warning
// in the UI rather than a reassuring "you can find this later".
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { InvitePanel } from './InvitePanel';
import { getProject } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);

  // Owner-only. The service enforces this too (it is the authority); checking
  // here as well is what turns a would-be 403 into a sensible screen.
  if (project.actingRole !== 'owner') redirect(`/projects/${id}`);

  const counterparty = project.members.find((m) => m.role === 'counterparty');

  return (
    <>
      <TopBar back={{ href: `/projects/${id}`, label: project.name }} />
      <main className="screen">
        <div>
          <div className="crumbs">{project.name}</div>
          <h1 className="scr">Invite your general contractor</h1>
          <p className="sub">
            R0 records agreements between two parties: you and one GC.
          </p>
        </div>

        {counterparty ? (
          <section className="card">
            <p>
              <strong>{counterparty.name}</strong> has already joined this record as the general
              contractor.
            </p>
            <Link className="btn" href={`/projects/${id}`}>
              Go to the project
            </Link>
          </section>
        ) : (
          <section className="card">
            <InvitePanel projectId={id} />
          </section>
        )}
      </main>
    </>
  );
}
