// A task's own URL (LINA-250) — `/projects/:id/plan/tasks/:stageKey`, cut onto
// `/api/v2` (LINA-396, Phase 12b.8 of the UI cutover, doc 22 §3). The v1 reads
// this page leaned on (`getBuild`/`getPlan`/`buildShellContext`/`hydrateDraft`)
// are gone; it now reads the live v2 WBS through the same tested seams the plan
// surface uses (`getPlanGrid` + `buildShellContextV2` + `planGridToDraft`), so a
// v2 build's task link resolves against the version the schedule service actually
// holds rather than the retired v1 plan API.
//
// Jira behaviour, which is the founder's ask: every task on the plan has an
// address you can paste into a message, and opening it lands on that task with
// its drawer already open. In v2 the address is the stage's stable v2 id
// (`StageRow.id`, which `planning-view.ts` notes IS the key — v2 ids don't
// re-mint on a re-save, unlike the v1 client key this page used to resolve).
//
// ── TWO SURFACES, ONE ADDRESS ────────────────────────────────────────────────
// What a link opens depends on what the plan currently IS, not on the link. v1
// switched on a plan-version status (draft vs proposed/accepted); v2 has no
// private draft, so the switch is the plan's baseline, exactly as `/plan` decides
// authoring vs read-only (`authoring = !isBaselined`, ADR-0014):
//   - the plan is NOT baselined  → the authoring grid with the task's drawer open
//     (identical to `/plan`, which is the point: the link is a shortcut into the
//     screen the task lives on, not a second editor);
//   - the plan IS baselined → a read-only task page with the same workspace
//     section. A frozen baseline is revised through change orders, never by typing
//     over a task here, so opening the editor over it would invite edits the save
//     path would refuse.
// Either way the workspace is the same component and the same v2 task id.
//
// AN UNKNOWN KEY IS A 404, NEVER AN EMPTY DRAWER. A key that names no row on this
// build's current plan is a dead address — rendering a blank task for it would
// invent work that does not exist. `getPlanGrid` also fails CLOSED to the empty
// plan for a viewer who cannot read the schedule (no org / not a participant), so
// a link to a build one cannot see is a 404 here, not a leak or a crash — the
// same answer the v2 workspace API gives.
//
// PARTIES ARE EMPTY ON v2, like every v2 plan surface (`V2PlanGridReadOnly`,
// `/plan`): the v1 member directory is not one of this cut's reads, so owner
// resolves to a neutral avatar and authoring does not assign (v2 inherits from
// the branch, D-33). It lights up once the v2 assignee model is threaded through.
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getPlanGrid } from '@/lib/v2/planning';
import { getRecordV2 } from '@/lib/v2/record';
import { planGridToDraft } from '@/lib/v2/planning-hydrate';
import { savePlanV2 } from '@/lib/v2/plan-write';
import { findRowByKey, collectRowKeys } from '@/lib/v2/planning-view';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { TradeChip, UnassignedAvatar } from '@/components/PartyAvatar';
import { formatDate } from '@/lib/format';
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

  // The grid and the build name in one round of reads, exactly as `/plan` does:
  // `getRecordV2` names the shell (fails closed to null), `getPlanGrid` gives the
  // WBS (fails closed to the empty plan for a viewer who cannot read it).
  const [grid, record] = await Promise.all([getPlanGrid(id), getRecordV2(id)]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  // Resolved against the version the viewer can actually read. A key that names no
  // row on the readable plan is a 404 — the same answer the workspace API gives,
  // never a screen that invents a task or leaks a build one cannot see.
  const hit = findRowByKey(grid.rows, stageKey);
  if (!hit) notFound();

  // A BASELINED plan is frozen: edits route through change orders (ADR-0014), so
  // it renders as the read-only task page. Everything else is the author's to
  // edit — the link drops them into the editor with this task's drawer open.
  const authoring = !grid.isBaselined;

  if (authoring) {
    return (
      <PortalShell
        user={shell.user}
        builds={shell.builds}
        activeBuild={{ id, name }}
        section="plan"
      >
        <PlanBuildEditor
          projectId={id}
          initialPhases={planGridToDraft(grid)}
          // Same v2 autosave the `/plan` editor uses (incremental diff →
          // schedule:apply + task PATCHes + link create/delete). No parties: v2
          // authoring inherits assignment from the branch (D-33).
          saveV2={savePlanV2.bind(null, id)}
          parties={[]}
          // Every grid row is server-held in v2, so the whole tree is "saved" —
          // this is what lets the permalinked task open its workspace on mount.
          savedStageKeys={collectRowKeys(grid.rows)}
          openStageKey={stageKey}
          procurementHref={`/projects/${id}/plan/procurement`}
        />
      </PortalShell>
    );
  }

  const level = hit.depth === 0 ? 'Phase' : hit.depth === 1 ? 'Task' : 'Sub-task';

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="plan"
    >
      <main className="pbx pbx--task">
        <header className="pbx-head">
          <div>
            <p className="pbx-eyebrow">{level}</p>
            <h1 className="pbx-title">{hit.row.name.trim() || `Untitled ${level.toLowerCase()}`}</h1>
            {hit.trail.length ? (
              <p className="pbx-drawer-under">{hit.trail.join(' › ')}</p>
            ) : null}
          </div>
          <Link className="btn" href={`/projects/${id}/plan`}>Back to the plan</Link>
        </header>

        {/* Read-only on purpose: this baseline is frozen, and the plan is revised
            through change orders, never by typing over a task here. */}
        <div className="pbx-drawer-meta">
          <span className="pbx-drawer-label">Owner</span>
          <span className="pbx-owner">
            <UnassignedAvatar size="md" />
            {/* No party directory on v2 yet (D-33): an assigned org we cannot name
                shows a neutral "—"; a genuinely unowned row reads "Unassigned". */}
            <span className="cap">{hit.row.assigneePartyId ? '—' : 'Unassigned'}</span>
          </span>

          <span className="pbx-drawer-label">Specialty</span>
          <span>{hit.row.trade ? <TradeChip trade={hit.row.trade} /> : <span className="cap">—</span>}</span>

          <span className="pbx-drawer-label">Start</span>
          <span>{hit.row.start ? formatDate(hit.row.start) : '—'}</span>

          <span className="pbx-drawer-label">Finish</span>
          <span>{hit.row.end ? formatDate(hit.row.end) : '—'}</span>
        </div>

        {/* The v2 task id IS the resolved row id (in v2 a row's id is its key). */}
        <TaskWorkspace taskId={hit.row.id} parties={[]} />
      </main>
    </PortalShell>
  );
}
