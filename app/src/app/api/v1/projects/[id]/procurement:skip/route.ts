// POST /api/v1/projects/:id/procurement:skip — Persona B's door: no RFP,
// straight to execution (LINA-280; slice-procurement-contract §1 route 8).
// Returns the full `ProcurementView` (§2) — the same read the select path
// returns, so the accordion's state is always the server's answer.
//
// Contract: docs/architecture/slice-procurement-contract.md §1, §2, §4.
// Colon-action suffix lives in the folder name — the whole segment is literal
// here (no dynamic capture needed), the same shape as `plan-versions:author`.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.skipProcurement(c));
}