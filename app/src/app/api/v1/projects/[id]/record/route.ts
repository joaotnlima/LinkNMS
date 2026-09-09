// GET /api/v1/projects/:id/record — the live record (D14, Slice B3 contract
// §3a): plan/schedule/money/history tabs + derived line/record state
// (accepted | deviation) + Compare. Both parties read (any seated party).
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.schedule.getRecord(c));
}