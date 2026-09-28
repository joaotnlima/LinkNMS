// The plan surface — cut onto `/api/v2` (LINA-320, S3 of the UI cutover, doc 22
// §3). This is THE build landing screen: `/projects/:id` redirects here, and the
// v2 portfolio (LINA-311, S1) lists only v2 builds, so every build that reaches
// this page is a v2 build. Reading it through the v1 plan API is what produced
// the "could not be loaded" crash (the QA blocker handed here from LINA-365);
// this cut reads the v2 schedule instead.
//
// ── WHAT S3 SHIPS ─────────────────────────────────────────────────────────────
// The READ half (LINA-320, PR #219) cut the live WBS grid + Gantt onto the tested
// `getPlanGrid` seam. This is the WRITE half (LINA-369): the same `PlanBuildEditor`
// the v1 plan authored through, now autosaving through `/api/v2` via the
// `savePlanV2` server action (incremental diff → `schedule:apply` + task PATCHes +
// link create/delete, one `client_change_id` per save). A build with no plan lands
// straight in the editor scaffold; an existing plan resumes into it; a BASELINED
// plan stays read-only (a frozen baseline is not free-authoring — that routes
// through change orders, ADR-0014). Assignment is not authored here (v2 inherits
// from the branch, D-33), and status stays the honest all-grey meter until the
// plan is signed (ADR-0019) — so the editor is mounted with no parties and no live
// stage ids, both of which arrive with their own v2 slices.
//
// The v1 sign-off / phase-negotiation panels are NOT carried here: v2 has no
// phases backend yet (that is S6, LINA-323, blocked on BE). Their absence is
// deliberate, not a regression — a fresh B2 build has nothing to sign off, and
// "send for approval" arrives with the v2 record.
//
// ── FAIL-CLOSED, FIRST-CLASS EMPTY STATES (doc 22 header + the S1 pattern) ─────
// The v2 access model is org-centric: a signed-in Clerk user with no mirror row,
// no active org, or who is not a participant on this build must NOT crash — those
// are ordinary states of a fresh B2 install (LINA-310). `getPlanGrid` collapses
// any authorization error to the EMPTY plan, and a WRITE the viewer cannot make
// comes back as a sentence beside the plan (`savePlanV2` returns `{ ok: false }`),
// never a stack trace.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn, getPlanTemplate } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getPlanGrid } from '@/lib/v2/planning';
import { planGridToDraft } from '@/lib/v2/planning-hydrate';
import { savePlanV2 } from '@/lib/v2/plan-write';
import { getRecordV2 } from '@/lib/v2/record';
import type { TemplatePhase } from '@/lib/plan-authoring';
import { PlanBuildEditor } from './build/PlanBuildEditor';
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

  // A BASELINED plan is frozen: edits route through change orders (ADR-0014), not
  // free authoring, so it stays read-only. Everything else — no plan yet, or a
  // plan still being shaped — is the author's to edit.
  const authoring = !grid.isBaselined;

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="plan"
    >
      {authoring ? (
        <PlanBuildEditor
          projectId={id}
          // Resume an existing plan; scaffold from the author's default template
          // for an empty build. `undefined` initialPhases is what makes the editor
          // seed rather than resume.
          initialPhases={hasPlan ? phases : undefined}
          templateBody={hasPlan ? undefined : await resolveTemplate()}
          // v2 authoring does not assign (v2 inherits from the branch, D-33) and
          // keeps status read-only on a draft (ADR-0019) — so no parties, no live
          // stage ids. Both arrive with their own v2 slices.
          parties={[]}
          saveV2={savePlanV2.bind(null, id)}
          // The door to the plan's Procurement surface (its own page, LINA-371).
          procurementHref={`/projects/${id}/plan/procurement`}
        />
      ) : (
        <main className="pi">
          <p style={{ marginBottom: '1rem' }}>
            <Link className="pbx-icon" href={`/projects/${id}/plan/procurement`}
              title="Put part of the plan out to tender and compare the bids"
              style={{ width: 'auto', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}>
              Tendering
            </Link>
          </p>
          <V2PlanGridReadOnly phases={phases} todayIso={todayIso} />
        </main>
      )}
    </PortalShell>
  );
}

/**
 * The author's default plan scaffold (names only), fail-closed. Same degradation
 * as the v1 editor: an unreachable template still leaves a usable editor, seeded
 * from the built-in skeleton. It is a user preference, not project data, so
 * reading it over v1 while the plan reads over v2 is fine — it writes nothing.
 */
async function resolveTemplate(): Promise<TemplatePhase[] | undefined> {
  try {
    const resolved = await getPlanTemplate();
    return resolved.body?.length ? resolved.body : undefined;
  } catch (err) {
    console.warn('[plan] could not resolve the default plan template', err);
    return undefined;
  }
}
