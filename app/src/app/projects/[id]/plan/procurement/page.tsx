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
import { collectRowOptions } from '@/lib/v2/planning-view';
import { getRecordV2 } from '@/lib/v2/record';
import { getMyRfps } from '@/lib/v2/tendering';
import { viewerHasActiveOrg } from '@/lib/v2/profile';
import { ProcurementSection, type TaskOption } from '@/components/ProcurementSection';
import '@/components/plan-import.css';
import '@/components/plan-build.css'; // the `.pbx-icon` link style shared with the plan editor

export const dynamic = 'force-dynamic';

export default async function ProcurementPage({
  params,
  // The per-package "Start tendering" deep-link (LINA-407) lands here with the
  // chosen row as `?task=<id>` and `?mode=light`, so the composer opens pre-set
  // to Light (design) with that package already picked. Both are optional — the
  // surface is reachable bare from the "Tendering" link too.
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ task?: string; mode?: string }>;
}) {
  const { id } = await params;
  const { task, mode } = await searchParams;
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

  // Candidate root tasks the composer tenders over → root_task_ids. Tendering is
  // per-task at ANY level now (LINA-420): a pre-construction phase can run several
  // concurrent tenders (architecture, electrical, plumbing…), each rooted at its
  // own task or sub-task. So the candidate list is the WHOLE WBS tree flattened —
  // not just the top-level phases — otherwise a "Start tendering" deep-link raised
  // on a nested task is silently dropped (it fails the `tasks.some` check below)
  // and lands on a bare list instead of the composer. This also lets the RFP list
  // resolve a nested task's name for its per-task label.
  const tasks: TaskOption[] = collectRowOptions(grid.rows);

  // getMyRfps is already org-scoped; narrow to this build so the section never
  // shows another project's tenders.
  const initialMyRfps = myRfps.filter((r) => r.project_id === id);

  // "Start tendering" from a task does two different things depending on whether
  // that task is ALREADY out to tender:
  //  • already tendered → open that RFP so the owner sees the responses submitted
  //    and can compare them (the LINA-420 wake: "can't see the responses … nor
  //    compare them"). We hand the section the existing RFP to select.
  //  • not yet → open the composer pre-picked on that task to raise a new tender.
  // A task may root more than one RFP over its life; we open the most recent
  // (getMyRfps returns newest-first), which is the one the owner just means.
  const existingForTask = task
    ? initialMyRfps.find((r) => r.root_task_ids.includes(task)) ?? null
    : null;

  const composeTaskId =
    !existingForTask && task && tasks.some((t) => t.id === task) ? task : null;
  const openRfpId = existingForTask?.id ?? null;
  const composeMode = mode === 'light' ? 'light' : 'detailed';

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
          composeTaskId={composeTaskId}
          composeMode={composeMode}
          openRfpId={openRfpId}
        />
      </main>
    </PortalShell>
  );
}
