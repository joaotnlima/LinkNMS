// POST /api/v1/projects/:id/plan-versions:author — direct plan authoring, the
// "build it here" route (LINA-228, ADR-0017). A WBS tree authored in the browser
// lands as a proposed v1 in ONE transaction (one plan_proposed ledger event + the
// stage projection), mirroring B1's plan-imports:confirm. Either project party;
// JSON body { stages }. Returns 201 { planVersionId, versionNo, status, stageCount,
// rootCount, auditEventId }.
//
// Contract: docs/architecture/slice-direct-plan-authoring-contract.md §0–§3.
// Colon-action style (`plan-versions:author`) matches the frozen B1/B2 URLs; the
// whole segment is a literal folder name here because no dynamic capture is needed.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.authorPlan(c));
}
