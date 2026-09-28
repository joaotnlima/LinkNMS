// The plan surface — cut onto `/api/v2` (LINA-320, S3 of the UI cutover, doc 22
// §3). This is THE build landing screen: `/projects/:id` redirects here, and the
// v2 portfolio (LINA-311, S1) lists only v2 builds, so every build that reaches
// this page is a v2 build. Reading it through the v1 plan API is what produced
// the "could not be loaded" crash (the QA blocker handed here from LINA-365);
// this cut reads the v2 schedule instead.
//
// ── WHAT S3 SHIPS, AND WHAT IT HONESTLY DEFERS ────────────────────────────────
// This increment is the READ half: the live WBS grid + Gantt, rendered read-only
// on the same `PlanGrid` the authoring editor uses (`V2PlanGridReadOnly`), from
// the tested `getPlanGrid` seam. Authoring on v2 (the write half) is the next
// increment (a child of LINA-320): the write seams `applyPlanDraft` /
// `applyPlanEdits` are already merged and unit-tested, but threading them into
// the 915-line autosave editor needs a created-row rekey pass on the
// audit-critical write path, so it ships on its own rather than riding this
// crash-fix. Until then a build with no plan yet shows an honest "authoring
// arrives next" panel rather than a v1 editor that would write to the wrong API.
//
// The v1 sign-off / phase-negotiation panels are NOT carried here: v2 has no
// phases backend yet (that is S6, LINA-323, blocked on BE). Their absence is
// deliberate, not a regression — a fresh B2 build has nothing to sign off.
//
// ── FAIL-CLOSED, FIRST-CLASS EMPTY STATES (doc 22 header + the S1 pattern) ─────
// The v2 access model is org-centric: a signed-in Clerk user with no mirror row,
// no active org, or who is not a participant on this build must NOT crash — those
// are ordinary states of a fresh B2 install (LINA-310). `getPlanGrid` collapses
// any authorization error to the EMPTY plan, and the shell fails closed to a
// neutral identity, so the worst case here is "no plan yet", never a stack trace.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getPlanGrid } from '@/lib/v2/planning';
import { planGridToDraft } from '@/lib/v2/planning-hydrate';
import { getRecordV2 } from '@/lib/v2/record';
import { V2PlanGridReadOnly } from './V2PlanGridReadOnly';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan`);

  // The grid and the build name in one round of reads. `getRecordV2` gives the
  // name for the shell (and fails closed to null); `getPlanGrid` gives the WBS.
  const [grid, record] = await Promise.all([getPlanGrid(id), getRecordV2(id)]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  const phases = planGridToDraft(grid);
  const hasPlan = phases.length > 0;

  // Anchor the Gantt's fallback window once, server-side, so the canvas is stable.
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="plan"
    >
      <main className="pi">
        {hasPlan ? (
          <V2PlanGridReadOnly phases={phases} todayIso={todayIso} />
        ) : (
          <EmptyPlan projectId={id} />
        )}
      </main>
    </PortalShell>
  );
}

/**
 * A build with no plan on v2 yet. Honest about the state (nothing authored) and
 * about the moment (authoring on v2 is the next increment) — never a fake editor
 * that would write to the retired v1 API. The record link keeps the reader moving
 * rather than stranding them on a dead end.
 */
function EmptyPlan({ projectId }: { projectId: string }) {
  return (
    <section className="pi-empty card" aria-labelledby="pi-empty-t">
      <h1 className="pi-empty-t" id="pi-empty-t">No plan yet</h1>
      <p className="cap">
        Nothing has been added to this build&rsquo;s plan. Authoring the plan on the new record is
        landing next — until then there is no plan to show here.
      </p>
      <Link className="btn" href={`/projects/${projectId}/record`}>Open the record</Link>
    </section>
  );
}
