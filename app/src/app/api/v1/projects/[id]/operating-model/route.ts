// PATCH /api/v1/projects/:id/operating-model — Band B wizard step 2 (ADR-0011).
// Owner-only; sets the operating model on a draft build. Every PATCH is a
// projection write + an `operating_model_set` ledger event in one unit.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.identity.setOperatingModel(c));
}