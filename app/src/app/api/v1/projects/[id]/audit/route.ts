// GET /api/v1/projects/:id/audit — the full ledger in seq order plus the
// chain-verify result (FR9). Honours If-None-Match against the head hash.
import { handle, container } from '@/server/gateway';

// Every API route reads a per-request session and hits Postgres.
export const dynamic = 'force-dynamic';

const withProjectId = (c: { params: Record<string, string> }) => ({
  ...c,
  params: { projectId: c.params.id },
});

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx, (c) => container().http.ledger.getAudit(withProjectId(c)));
}
