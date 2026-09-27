// The plan surface — now a single-page accordion of the two phases
// (LINA-281, ADR-0023 §4/§6). Procurement and Execution stack as collapsible
// sections on this one URL; the per-phase route split is gone. `/plan/build` and
// `/plan/import` 307-redirect here (?compose=), so authoring is an in-page action
// on the Execution section rather than a route of its own.
//
// ── ONE URL, EVERY STATE ─────────────────────────────────────────────────────
// `/projects/:id/plan` is the plan whatever the plan currently is: nothing
// imported yet (D7), a version open for review (D11/D12/D12a), a frozen baseline
// (D13), and now — above all of that — which phase the build is in. A separate
// URL per phase or per state would go stale the moment the state changed and
// would leave every redirect (the import's, the acceptance's, a phase
// transition's) pointing at a screen about a moment that has passed.
//
// ── WHY THE ACTING PARTY IS READ HERE ────────────────────────────────────────
// The screen needs it to decide which affordances exist (proposer → withdraw,
// reviewer → accept/request-changes/reject, and — new — approver → sign off vs.
// requester → wait). It is read from the VERIFIED session server-side and passed
// down, never sent back up: every transition derives its actor from the session
// again on the server, so this value shapes buttons and authorises nothing.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getPhases, getPlan, getPlanTemplate, isSignedIn, type WirePhase } from '@/lib/api';
import { currentSession } from '@/server/session';
import { directoryOf } from '@/lib/view';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { hydrateDraft, type PhaseDraft, type TemplatePhase } from '@/lib/plan-authoring';
import { stageIdsByKey, stageKeysOf } from '@/lib/task-workspace';
import { openRequest } from '@/lib/phase-signoff';
import { SignOffPanel } from '@/components/SignOffPanel';
import { getScheduleV2, v2TasksToStageNodes, toV2PlanRows, type V2Schedule } from '@/lib/v2/schedule';
import { PlanBaseline, type PartyRef } from './PlanBaseline';
import { PlanBuildEditor } from './build/PlanBuildEditor';
import { PlanImportWizard } from './import/PlanImportWizard';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

type Compose = 'build' | 'import' | null;

export default async function PlanPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string; drafted?: string; compose?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan`);

  // S3: probe v2 first. v2 returns null when the project lives only in v1
  // (404/403) — in that case fall through to the v1 getPlan path. Both
  // reads run in parallel with the build/session reads for no added latency.
  const [build, planV1, v2Schedule, phasesResult, session] = await Promise.all([
    getBuild(id),
    getPlan(id),
    getScheduleV2(id),
    getPhases(id),
    currentSession(),
  ]);

  // v2Schedule != null → this is a v2 project; use v2 data model.
  // v2Schedule === null → v1-only project; fall back to v1 plan.
  const isV2Project = v2Schedule !== null;
  // Synthesise a null-like PlanBaselineView for v2 projects so the v1 display
  // path (PlanBaseline) still works for the review surface — the v2 task rows
  // are injected via a synthetic "current" version. The proposal workflow is
  // suppressed because v2 has no version-based approve/reject concept.
  const plan = isV2Project
    ? buildV2PlanView(v2Schedule!)
    : planV1;

  const shell = await buildShellContext(id, build.name);
  const { imported, drafted, compose: composeRaw } = await searchParams;
  const compose: Compose = composeRaw === 'build' || composeRaw === 'import' ? composeRaw : null;
  const isGC = build.actingRole === 'counterparty';

  const directory = directoryOf(build);
  const parties: PartyRef[] = build.members.map((m) => ({
    partyId: m.partyId,
    name: directory.get(m.partyId)?.name ?? 'Unknown party',
    role: m.role,
  }));

  const execution = phasesResult.phases.find((p) => p.kind === 'execution') ?? null;

  // "Is there a plan?" is `current || baseline || history`, not a stage count: a
  // withdrawn v1 leaves a build with no open version and a real history, and
  // showing "add your plan" over a negotiation that happened would be the record
  // forgetting it.
  const hasPlan = isV2Project
    ? v2Schedule!.tasks.length > 0
    : (planV1.current !== null || planV1.baseline !== null || planV1.history.length > 0);

  const executionSlot = await buildExecutionSlot({
    id, compose, plan, build, parties, execution, session, hasPlan, isGC,
    isV2Project, v2Schedule,
  });

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <main className="pi">
        {/* The stamp the import returned (B1 contract §7). Shown once, on the
            redirect that carried it — the durable copy is the ledger event, which
            is why this links there rather than pretending to be it. */}
        {imported ? (
          <div className="pi-stamp" role="status">
            <p className="pi-stamp-t">Plan imported</p>
            <p className="cap">
              Recorded as one event on the shared record:{' '}
              <span className="pi-stamp-id">{imported}</span>
            </p>
            <Link className="btn" href={`/projects/${id}/audit`}>See it in the audit trail</Link>
          </div>
        ) : null}

        {/* The stamp the :author write returned (LINA-228/230). Saving is PRIVATE
            drafting — the copy says so plainly: nothing is sent yet. */}
        {drafted ? (
          <div className="pi-stamp" role="status">
            <p className="pi-stamp-t">Draft saved</p>
            <p className="cap">
              Saved as your private draft — the other party cannot see it and no approval has been
              requested. Recorded as one event on the shared record:{' '}
              <span className="pi-stamp-id">{drafted}</span>
            </p>
            <Link className="btn" href={`/projects/${id}/audit`}>See it in the audit trail</Link>
          </div>
        ) : null}

        {/* The plan surface renders directly — no Procurement/Execution
            accordion wrapper (founder, LINA-306): the two page-level sections
            added noise around the one thing this URL is for, the plan itself.
            Procurement returns here as its own surface once its BE lands
            (tracked under LINA-281); the per-phase collapse now lives INSIDE the
            grid, on each phase row, where folding a phase actually reads. */}
        {executionSlot}
      </main>
    </PortalShell>
  );
}

/**
 * The Execution section body. It carries the whole plan lifecycle: the authoring
 * editors (folded in from the retired `/plan/build` and `/plan/import` routes via
 * `?compose=`), the proposal/baseline surface, and the sign-off controls.
 */
async function buildExecutionSlot(ctx: {
  id: string;
  compose: Compose;
  plan: ReturnType<typeof buildV2PlanView> | Awaited<ReturnType<typeof getPlan>>;
  build: Awaited<ReturnType<typeof getBuild>>;
  parties: PartyRef[];
  execution: WirePhase | null;
  session: Awaited<ReturnType<typeof currentSession>>;
  hasPlan: boolean;
  isGC: boolean;
  isV2Project: boolean;
  v2Schedule: V2Schedule | null;
}) {
  const { id, compose, plan, parties, execution, session, isGC, isV2Project, v2Schedule } = ctx;

  // ── Authoring, folded in from the retired sub-routes ──────────────────────
  if (compose === 'import') {
    return <PlanImportWizard projectId={id} projectName={ctx.build.name} />;
  }

  // The plan surface IS the interactive Gantt editor whenever the plan is still
  // the author's to shape — no plan yet, or an unsent draft.
  // For v2 projects: always show the editor (v2 has no proposal workflow at the
  // plan grid level; the plan is always editable by the authorised party).
  // For v1: same as before — draft or no plan → editor; proposed/frozen → review.
  const v1Authoring = !isV2Project && (
    compose === 'build'
    || (plan.baseline === null && (plan.current === null || plan.current.status === 'draft'))
  );
  const authoring = isV2Project || v1Authoring;

  if (authoring) {
    const template = await resolveTemplate();
    let draft: PhaseDraft[] | undefined;
    let savedStageKeys: string[] = [];
    let initialStageIds: Record<string, string> = {};
    let v2ExistingTaskIds: string[] = [];

    if (isV2Project && v2Schedule) {
      // Resume editing from existing v2 tasks (B2: draft = always open for edit).
      if (v2Schedule.tasks.length > 0) {
        const stageNodes = v2TasksToStageNodes(v2Schedule.tasks);
        draft = hydrateDraft(stageNodes);
      }
      v2ExistingTaskIds = v2Schedule.tasks.map((t) => t.id);
    } else if (!isV2Project) {
      // v1 path: resume saved draft if one exists.
      draft = plan.current?.status === 'draft' ? hydrateDraft(plan.current.stages) : undefined;
      savedStageKeys = [...stageKeysOf(plan.current?.stages)];
      initialStageIds = stageIdsByKey(plan.current?.stages);
    }

    return (
      <PlanBuildEditor
        projectId={id}
        initialPhases={draft}
        templateBody={template}
        parties={parties}
        savedStageKeys={savedStageKeys}
        initialStageIds={initialStageIds}
        isV2={isV2Project}
        v2ExistingTaskIds={v2ExistingTaskIds}
        importHref={isGC ? `/projects/${id}/plan?compose=import` : null}
      />
    );
  }

  // ── The plan itself (v1 only below: v2 is always in authoring mode) ───────
  const taskCount = (plan.current?.stages ?? []).length;
  const pending = openRequest(execution);
  const partyNames: Record<string, string> = Object.fromEntries(
    parties.map((p) => [p.partyId, p.name]),
  );
  const viewer = {
    partyId: session?.partyId ?? null,
    canRequest: true,
    canDecide: pending !== null && pending.requestedBy !== (session?.partyId ?? null),
  };

  return (
    <>
      <PlanBaseline
        projectId={id}
        view={plan}
        actorPartyId={session?.partyId ?? null}
        parties={parties}
      />

      {execution ? (
        <SignOffPanel
          projectId={id}
          phase={execution}
          viewer={viewer}
          taskCount={taskCount}
          partyNames={partyNames}
          changeOrderHref={`/projects/${id}/change-orders/new`}
        />
      ) : null}
    </>
  );
}

/**
 * The resolved default scaffold (LINA-242), or undefined if it could not be read.
 * A template is a convenience, not a permission: a failure degrades to the
 * editor's built-in PLAN_SKELETON rather than an error page. Swallowed and
 * logged, never rethrown.
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

/**
 * Wraps a v2 schedule in the `PlanBaselineView` shape so PlanBaseline can render
 * the v2 tasks on the existing grid without changes. The v2 plan is always
 * "draft" from the v1 workflow perspective — there is no version-based propose/
 * accept cycle; the plan is simply the current set of tasks.
 *
 * This is a shim for the display path only (the v2 authoring path passes tasks
 * directly to `PlanBuildEditor` via `isV2`). The proposal / review / baseline
 * affordances in PlanBaseline are naturally suppressed because `current.status`
 * stays `'draft'` — `canWithdraw` and `canReview` both return false for a draft.
 */
function buildV2PlanView(schedule: V2Schedule): import('@/lib/plan-baseline').PlanBaselineView {
  const stageNodes = v2TasksToStageNodes(schedule.tasks);
  return {
    baseline: null,
    current: schedule.tasks.length === 0 ? null : {
      id: 'v2-synthetic',
      versionNo: null,
      status: 'draft',
      sourceImportId: null,
      supersedesVersionId: null,
      proposedByPartyId: '',
      createdAt: new Date().toISOString(),
      frozenAt: null,
      acceptances: [],
      stages: stageNodes,
    },
    history: [],
  };
}

