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
// The execution sign-off is carried here (LINA-323, S6): once the v2 phases
// backend landed (S6-BE, ADR-0024), the `SignOffPanel` reads the execution phase
// via `getPhasesV2` and posts request/approve/reject to `/api/v2`. A pending or
// approved sign-off LOCKS the plan grid (read-only) — the "clay/amber locked-grid"
// UX (ADR-0023 §6). The Procurement phase's surface is the Tendering link below
// (LINA-371); the two-section accordion the v1 plan used (LINA-281) was retired
// when this page became a single-surface editor (LINA-306/320), so S6 preserves
// the phase-driven sign-off UX — the substantive half — rather than the collapsed
// accordion widget.
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
import { savePlanV2, reportProgressV2 } from '@/lib/v2/plan-write';
import { getRecordV2 } from '@/lib/v2/record';
import { getPhasesV2, getViewerPersonId } from '@/lib/v2/phases';
import { executionPhase, signOffViewer } from '@/lib/v2/phases-view';
import { countPlanTasks, isPlanLocked } from '@/lib/phase-signoff';
import type { TemplatePhase } from '@/lib/plan-authoring';
import { PlanBuildEditor } from './build/PlanBuildEditor';
import { V2PlanGridReadOnly } from './V2PlanGridReadOnly';
import { SignOffPanel } from '@/components/SignOffPanel';
import '@/components/plan-import.css';
import '@/components/sign-off.css';

export const dynamic = 'force-dynamic';

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan`);

  // The grid, the build name, the phases, and who is looking — in one round of
  // reads. `getRecordV2` gives the shell name (fails closed to null); `getPlanGrid`
  // gives the WBS; `getPhasesV2` gives the sign-off state (fails closed to []); and
  // `getViewerPersonId` is the id the sign-off requests are keyed on.
  const [grid, record, phaseList, myPersonId] = await Promise.all([
    getPlanGrid(id),
    getRecordV2(id),
    getPhasesV2(id),
    getViewerPersonId(),
  ]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  const phases = planGridToDraft(grid);
  const hasPlan = phases.length > 0;

  // Anchor the Gantt's fallback window once, server-side, so the canvas is stable.
  const todayIso = new Date().toISOString().slice(0, 10);

  // The execution phase carries the plan and gets signed off (ADR-0024). A pending
  // request or an approved sign-off locks the plan (ADR-0023 §6): a plan under
  // review must not move beneath the approver, and a signed-off plan is a
  // commitment (edits route through change orders). `taskCount` gates the "Request
  // sign-off" button — you cannot sign off an empty plan.
  const execution = executionPhase(phaseList);
  const viewer = signOffViewer(execution, myPersonId);
  const taskCount = countPlanTasks(phases);
  const signOffLocked = isPlanLocked(execution);

  // A BASELINED plan is frozen: edits route through change orders (ADR-0014), not
  // free authoring, so it stays read-only. A plan under or past sign-off is locked
  // the same way. Everything else — no plan yet, or a plan still being shaped — is
  // the author's to edit.
  const authoring = !grid.isBaselined && !signOffLocked;

  // Show the sign-off panel only when sign-off is actually part of this build's
  // story: the execution phase is live (active / signed_off / archived) OR it
  // already carries a request. A fresh build seeds execution as `pending`
  // (ensurePhases, hasSignedContractor:false) and there is NO v2 path yet that
  // flips it to `active` — the procurement→execution activation (contractor
  // signed) is not wired on v2 (only `signed_off` is written today). So on every
  // current build the phase is pending-with-no-history and the panel stays hidden,
  // keeping the S3 fresh-build editor clean rather than showing a permanently
  // disabled "execution phase not active yet" banner. The panel — and the whole
  // request/approve/reject flow — lights up automatically the moment an activation
  // flow lands or a request exists. (Tracked as the S6 dormancy note; ADR-0024.)
  const showSignOff = execution != null
    && (execution.status !== 'pending' || execution.signOffRequests.length > 0);

  // The one place the sign-off panel is configured; rendered above whichever plan
  // surface (editor or read-only grid) is showing. `partyNames` is omitted: v2
  // keys sign-off on person ids for which the plan surface holds no directory yet,
  // so the panel uses its honest "the other party"/"the approver" fallback (S2
  // dashboard resolves per-person names). Nothing is invented.
  const signOff = showSignOff ? (
    <SignOffPanel
      projectId={id}
      phase={execution}
      viewer={viewer}
      taskCount={taskCount}
      changeOrderHref={`/projects/${id}/change-orders`}
    />
  ) : null;

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="plan"
    >
      {signOff}
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
          // The status picker's v2 progress-write door (LINA-384). Append-only,
          // keyed on the stable v2 task id; refusals roll the picker back inline.
          reportProgressV2={reportProgressV2}
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
