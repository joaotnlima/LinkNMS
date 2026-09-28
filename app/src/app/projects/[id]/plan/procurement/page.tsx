// The tendering surface — its own page, mounted on `/api/v2` (LINA-371).
//
// The v2-native RFP composer + proposals inbox (`components/ProcurementSection`,
// LINA-361) existed but nothing rendered it: `/plan` dropped its Procurement
// accordion when the founder folded the plan grid onto the page directly
// (LINA-306, "Procurement returns as ITS OWN SURFACE once its BE lands"). This is
// that surface. It is a sibling route of `/plan`, reached by the "Tendering" link
// in the plan editor's tools row — not a wrapping section around the grid, which
// is the chrome LINA-306 removed.
//
// ── v1/v2 DISPATCH (the S3 open question, resolved) ────────────────────────────
// There is no branch. `/plan` is already v2-only — `/projects/:id` redirects here
// and the v2 portfolio lists only v2 builds (LINA-320/369), so every build that
// reaches this nested route is a v2 build and the surface is always the v2 one.
//
// ── FAIL-CLOSED, FIRST-CLASS EMPTY STATES (the S1/S3 pattern) ──────────────────
// The v2 access model is org-centric. A signed-in viewer with no mirror row, no
// active org, or who is not a participant on this build must NOT crash: the reads
// below each fail closed (empty plan, empty RFP list, no org), and the section
// renders the neutral "pick an organisation" / "no tenders yet" states rather
// than a stack trace.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getPlanGrid } from '@/lib/v2/planning';
import { getRecordV2 } from '@/lib/v2/record';
import { getMyRfps } from '@/lib/v2/tendering';
import { viewerHasActiveOrg } from '@/lib/v2/profile';
import { ProcurementSection, type TaskOption } from '@/components/ProcurementSection';
import '@/components/plan-import.css';
import '@/components/plan-build.css'; // the `.pbx-icon` link style shared with the plan editor

export const dynamic = 'force-dynamic';

export default async function ProcurementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/procurement`);

  // One round of reads: the plan tree (candidate tasks to tender over), the build
  // name (shell breadcrumb), the org's RFPs for this project (first paint, not a
  // spinner), and whether an org is even selected (the neutral no-org state).
  const [grid, record, myRfps, hasActiveOrg] = await Promise.all([
    getPlanGrid(id),
    getRecordV2(id),
    getMyRfps(),
    viewerHasActiveOrg(),
  ]);

  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  // Candidate root tasks the composer tenders over → root_task_ids. The top-level
  // WBS rows (the phases) are the natural packages; tendering one carries its whole
  // subtree as a BoQ. Finer-grained sub-branch selection is a later refinement.
  const tasks: TaskOption[] = grid.rows.map((r) => ({ id: r.id, name: r.name }));

  // getMyRfps is already org-scoped; narrow to this build so the section never
  // shows another project's tenders.
  const initialMyRfps = myRfps.filter((r) => r.project_id === id);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="plan"
      crumb="Procurement"
      align="start"
    >
      <main className="pi">
        <p style={{ marginBottom: '1rem' }}>
          <Link className="pbx-icon" href={`/projects/${id}/plan`}
            style={{ width: 'auto', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}>
            ← Back to plan
          </Link>
        </p>
        <ProcurementSection
          projectId={id}
          tasks={tasks}
          hasActiveOrg={hasActiveOrg}
          initialMyRfps={initialMyRfps}
        />
      </main>
    </PortalShell>
  );
}
