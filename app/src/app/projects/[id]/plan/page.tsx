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
import { stageKeysOf } from '@/lib/task-workspace';
import { openRequest } from '@/lib/phase-signoff';
import { SignOffPanel } from '@/components/SignOffPanel';
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

  const [build, plan, phasesResult, session] = await Promise.all([
    getBuild(id), getPlan(id), getPhases(id), currentSession(),
  ]);
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
  const hasPlan = plan.current !== null || plan.baseline !== null || plan.history.length > 0;

  const executionSlot = await buildExecutionSlot({
    id, compose, plan, build, parties, execution, session, hasPlan, isGC,
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
  plan: Awaited<ReturnType<typeof getPlan>>;
  build: Awaited<ReturnType<typeof getBuild>>;
  parties: PartyRef[];
  execution: WirePhase | null;
  session: Awaited<ReturnType<typeof currentSession>>;
  hasPlan: boolean;
  isGC: boolean;
}) {
  const { id, compose, plan, parties, execution, session, hasPlan, isGC } = ctx;

  // ── Authoring, folded in from the retired sub-routes ──────────────────────
  if (compose === 'import') {
    return <PlanImportWizard projectId={id} projectName={ctx.build.name} />;
  }
  if (compose === 'build') {
    const template = await resolveTemplate();
    // "Keep editing" resumes the saved draft. getPlan surfaces a draft to its
    // author ONLY (LINA-230), so a `draft` current is this party's to resume;
    // otherwise the editor scaffolds from `template`. Order matters: a saved
    // draft always wins, or scaffolding would silently discard saved work.
    const draft: PhaseDraft[] | undefined =
      plan.current?.status === 'draft' ? hydrateDraft(plan.current.stages) : undefined;
    const savedStageKeys = [...stageKeysOf(plan.current?.stages)];
    return (
      <PlanBuildEditor
        projectId={id}
        initialPhases={draft}
        templateBody={template}
        parties={parties}
        savedStageKeys={savedStageKeys}
      />
    );
  }

  // ── The plan itself, plus the sign-off controls once a plan exists ────────
  // The "is there anything to sign off" count comes from the OPEN version: a
  // sign-off is requested on the active plan, which is `current`. A frozen
  // baseline with no open version is not a plan you can request sign-off on
  // (edits route through change orders by then), so it correctly counts as zero.
  const taskCount = (plan.current?.stages ?? []).length;
  const pending = openRequest(execution);
  // A plain party-id → name map for the sign-off panel. It must be a serializable
  // object, not the `directory` Map or a resolver function — SignOffPanel is a
  // Client Component and neither crosses the RSC boundary (LINA-306).
  const partyNames: Record<string, string> = Object.fromEntries(
    parties.map((p) => [p.partyId, p.name]),
  );
  const viewer = {
    partyId: session?.partyId ?? null,
    // v1: any project member may request sign-off (ADR-0023 Addendum A §2). The
    // page only loads for a member, so this is true here.
    canRequest: true,
    // The approver is anyone who did NOT open the pending request — a plan is
    // signed off BY THE OTHER PARTY, never self-approved. The server enforces
    // `cannot_self_approve` regardless; this only decides which control shows.
    canDecide: pending !== null && pending.requestedBy !== (session?.partyId ?? null),
  };

  return (
    <>
      {hasPlan ? (
        <PlanBaseline
          projectId={id}
          view={plan}
          actorPartyId={session?.partyId ?? null}
          parties={parties}
        />
      ) : (
        <NoPlanYet projectId={id} isGC={isGC} />
      )}

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
 * The two routes into a plan that does not exist yet (pen D7). They are folded
 * onto this page: "Build the plan" and "Upload plan" open the authoring editor
 * inline via `?compose=`, on this same URL — the standalone `/plan/build` and
 * `/plan/import` routes now redirect here, so a link to them would loop.
 */
function NoPlanYet({ projectId, isGC }: { projectId: string; isGC: boolean }) {
  return (
    <>
      <div className="pi-head">
        <h1 className="pi-title">Add your plan</h1>
        <p className="pi-lede">
          Actions, sub-actions and the dates they run. However it gets in, the plan is the
          contractor&apos;s — nothing here is binding until both parties agree it.
        </p>
      </div>

      <div className="pi-routes">
        <section className="pi-route">
          <p className="pi-route-n">Route 1</p>
          <h2 className="pi-route-t">Import a spreadsheet</h2>
          <p className="pi-route-b">
            You already have the plan in Excel. Choose the file, tell us what each column means,
            confirm what will be stored.
          </p>
          <p className="pi-route-meta">.xlsx · multi-sheet · you pick the tab</p>
          {isGC ? (
            <Link className="btn primary" href={`/projects/${projectId}/plan?compose=import`}>Upload plan</Link>
          ) : (
            // B1 contract §5: importing is the GC's, not the owner's. An owner
            // sees the route and why it is not theirs rather than a button that 403s.
            <p className="cap">The plan is the contractor&apos;s to bring in.</p>
          )}
        </section>

        <section className="pi-route">
          <p className="pi-route-n">Route 2</p>
          <h2 className="pi-route-t">Build it here</h2>
          <p className="pi-route-b">
            No spreadsheet — start from a standard skeleton, then add phases and tasks directly and
            date them where you know them.
          </p>
          <p className="pi-route-meta">seeded skeleton · phases &amp; tasks · optional dates</p>
          {/* Either party may author (ADR-0017 §3): it is proposed to the other to
              agree, so there is no role gate here. */}
          <Link className="btn primary" href={`/projects/${projectId}/plan?compose=build`}>Build the plan</Link>
        </section>
      </div>

      <p className="cap">
        Whichever route you take, the plan is the contractor&apos;s: they own it and only they can
        revise it. The owner can propose a change, never overwrite one.
      </p>
    </>
  );
}
