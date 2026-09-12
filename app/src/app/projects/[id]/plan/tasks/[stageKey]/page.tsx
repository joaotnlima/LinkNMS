// A task's own URL (LINA-250) — `/projects/:id/plan/tasks/:stageKey`.
//
// Jira behaviour, which is the founder's ask: every task on the plan has an
// address you can paste into a message, and opening it lands on that task with
// its drawer already open. The address is the stage's stable `key`
// (LINA-249, migration 0011), not its row id — a draft re-save re-mints stage
// ids, so an id-shaped link would rot the next time anyone pressed Save.
//
// ── TWO SURFACES, ONE ADDRESS ────────────────────────────────────────────────
// What a link opens depends on what the plan currently IS, not on the link:
//   - the plan is this party's DRAFT  → the authoring grid with the task's
//     drawer open (identical to /plan/build, which is the point: the link is a
//     shortcut into the screen the task lives on, not a second editor);
//   - the plan is proposed or accepted → a read-only task page with the same
//     workspace section. Opening the authoring editor over a version that is
//     out for approval would invite edits the save endpoint would refuse
//     (`open_plan_exists`), which is a lie told by a screen.
// Either way the workspace is the same component and the same API.
//
// AN UNKNOWN KEY IS A 404, NEVER AN EMPTY DRAWER. A key that names no stage on
// this build's current plan is a dead address — rendering a blank task for it
// would invent work that does not exist.
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getPlan, getPlanTemplate, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { PartyAvatar, TradeChip, UnassignedAvatar } from '@/components/PartyAvatar';
import { hydrateDraft, type TemplatePhase } from '@/lib/plan-authoring';
import { directoryOf } from '@/lib/view';
import { formatDate } from '@/lib/format';
import { partyOf, partyIndex, roleWord, UNKNOWN_PARTY, type PartyRef } from '@/lib/party-display';
import { findStageByKey, stageKeysOf } from '@/lib/task-workspace';
import { PlanBuildEditor } from '../../build/PlanBuildEditor';
import '@/components/plan-build.css';

export const dynamic = 'force-dynamic';

export default async function TaskPermalinkPage({
  params,
}: {
  params: Promise<{ id: string; stageKey: string }>;
}) {
  const { id, stageKey: raw } = await params;
  const stageKey = decodeURIComponent(raw);
  if (!(await isSignedIn())) {
    redirect(`/sign-in?next=/projects/${id}/plan/tasks/${encodeURIComponent(stageKey)}`);
  }

  const [build, plan] = await Promise.all([getBuild(id), getPlan(id)]);
  const shell = await buildShellContext(id, build.name);

  // Resolved against the version the party can actually read. `getPlan` shows a
  // draft to its author only (LINA-230), so a link to a task on someone else's
  // draft is a 404 here — the same answer the workspace API gives, rather than a
  // screen that leaks the existence of a private draft.
  const hit = findStageByKey(plan.current?.stages ?? null, stageKey);
  if (!hit) notFound();

  const directory = directoryOf(build);
  const parties: PartyRef[] = build.members.map((m) => ({
    partyId: m.partyId,
    name: directory.get(m.partyId)?.name ?? UNKNOWN_PARTY,
    role: m.role,
  }));

  // The author's own draft → the real screen, drawer open on this task.
  if (plan.current?.status === 'draft') {
    return (
      <PortalShell
        user={shell.user}
        builds={shell.builds}
        activeBuild={{ id, name: build.name }}
        section="plan"
      >
        <PlanBuildEditor
          projectId={id}
          initialPhases={hydrateDraft(plan.current.stages)}
          templateBody={await resolveTemplate()}
          parties={parties}
          savedStageKeys={[...stageKeysOf(plan.current.stages)]}
          openStageKey={stageKey}
        />
      </PortalShell>
    );
  }

  const owner = partyOf(partyIndex(parties), hit.node.assigneePartyId ?? null);
  const level = hit.depth === 0 ? 'Phase' : hit.depth === 1 ? 'Task' : 'Sub-task';

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <main className="pbx pbx--task">
        <header className="pbx-head">
          <div>
            <p className="pbx-eyebrow">{level}</p>
            <h1 className="pbx-title">{hit.node.name.trim() || `Untitled ${level.toLowerCase()}`}</h1>
            {hit.trail.length ? (
              <p className="pbx-drawer-under">{hit.trail.join(' › ')}</p>
            ) : null}
          </div>
          <Link className="btn" href={`/projects/${id}/plan`}>Back to the plan</Link>
        </header>

        {/* Read-only on purpose: this version is out for approval or frozen, and
            the plan is revised through the proposal flow, never by typing over a
            task here. */}
        <div className="pbx-drawer-meta">
          <span className="pbx-drawer-label">Owner</span>
          <span className="pbx-owner">
            {owner ? <PartyAvatar party={owner} size="md" /> : <UnassignedAvatar size="md" />}
            <span>{owner ? `${owner.name} · ${roleWord(owner.role)}` : 'Unassigned'}</span>
          </span>

          <span className="pbx-drawer-label">Specialty</span>
          <span>{hit.node.trade ? <TradeChip trade={hit.node.trade} /> : <span className="cap">—</span>}</span>

          <span className="pbx-drawer-label">Start</span>
          <span>{hit.node.plannedStartDate ? formatDate(hit.node.plannedStartDate) : '—'}</span>

          <span className="pbx-drawer-label">Finish</span>
          <span>{hit.node.plannedEndDate ? formatDate(hit.node.plannedEndDate) : '—'}</span>
        </div>

        <TaskWorkspace projectId={id} stageKey={stageKey} parties={parties} />
      </main>
    </PortalShell>
  );
}

/** Same degradation as /plan/build: an unreachable template must still leave a usable editor. */
async function resolveTemplate(): Promise<TemplatePhase[] | undefined> {
  try {
    const resolved = await getPlanTemplate();
    return resolved.body?.length ? resolved.body : undefined;
  } catch (err) {
    console.warn('[plan/tasks] could not resolve the default plan template', err);
    return undefined;
  }
}
