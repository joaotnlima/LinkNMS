'use client';

// The v2 plan grid, READ-ONLY (LINA-320, S3 of the UI cutover, doc 22 §3).
//
// S3 cuts the plan surface onto `/api/v2`. This slice ships the READ half: the
// live WBS schedule, fetched server-side through the tested planning seam
// (`lib/v2/planning.ts::getPlanGrid`) and projected into the grid's own
// `PhaseDraft[]` shape (`lib/v2/planning-hydrate.ts::planGridToDraft`), rendered
// on the SAME `PlanGrid` the authoring editor uses — so the Gantt UX is
// unchanged, only frozen. Authoring on v2 (the write half) is the next increment
// (child of LINA-320): the write seams (`applyPlanDraft`/`applyPlanEdits`) are
// already merged and tested, but wiring them into the autosave editor needs the
// created-row rekey pass, tracked separately so this crash-fix ships now.
//
// `disabled` locks every affordance (LINA-282: a disabled PlanGrid is a frozen
// grid — no add/rename/drag/link/status). The handlers below therefore never
// fire; they exist only to satisfy the prop contract. `parties` is empty on v2
// (the v1 party directory is not one of this slice's reads): owner cells resolve
// to a neutral avatar rather than a name, which is honest for a read-only view
// and lights up once the authoring slice threads the v2 assignee model through.
import { useCallback } from 'react';

import type { PhaseDraft } from '@/lib/plan-authoring';
import type { PartyRef } from '@/lib/party-display';
import { PlanGrid } from './build/PlanGrid';
import '@/components/plan-build.css';

const NO_PARTIES: PartyRef[] = [];
const NO_ROWS = new Set<string>();

export function V2PlanGridReadOnly({
  phases,
  todayIso,
}: {
  phases: PhaseDraft[];
  /** Today as 'YYYY-MM-DD' — anchors the Gantt's fallback window for undated
   *  rows. Passed from the server so the canvas is stable across a render. */
  todayIso: string;
}) {
  // A frozen grid fires no handler; these are inert stand-ins for the contract.
  const noop = useCallback(() => {}, []);
  const noopKey = useCallback(() => '', []);

  return (
    <PlanGrid
      phases={phases}
      parties={NO_PARTIES}
      litRows={NO_ROWS}
      disabled
      todayIso={todayIso}
      onOpenRow={noop}
      onRename={noop}
      onSetDate={noop}
      onDates={noop}
      onAssign={noop}
      onTrade={noop}
      onAddPhase={noopKey}
      onAddTask={noopKey}
      onAddSubtask={noopKey}
      onRemovePhase={noop}
      onRemoveTask={noop}
      onRemoveSubtask={noop}
      onReorderPhase={noop}
      onReorderTask={noop}
      onReorderSubtask={noop}
      onPromote={noop}
      onDemote={noop}
      onLinkDep={noop}
      onUnlinkDep={noop}
    />
  );
}
