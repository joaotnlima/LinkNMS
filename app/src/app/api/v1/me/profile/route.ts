// POST /api/v1/me/profile — first-login account setup (LINA-189).
//
// Contract: docs/architecture/api-me-profile-contract.md.
//
// ── WHY THIS FILE EXISTS AT THIS PATH ────────────────────────────────────────
// The account-setup screen has been POSTing to this endpoint since LINA-132 and
// getting a 404, because the handler was written for `apps/api` — a standalone
// Fastify service that was designed, built, tested, and never deployed. The
// portal is one Next app on one host; there is no second origin serving
// `/api/*`, so "the API" for the browser is this app. The handler therefore
// belongs here, on the app's single versioned API surface, next to GET
// /api/v1/me which answers about the same party from the same table.
//
// The contract doc's unversioned `/api/me/profile` was the Fastify service's
// path. Every other endpoint this app serves is under `/api/v1`, and one API
// namespace beats honouring a path from a deployment that does not exist.
//
// Like every route under api/v1, this file holds NO domain logic: `handle()`
// resolves the acting party from the verified Clerk session (ADR-0004 — never
// from the body) and the identity service owns validation, the role-vocabulary
// mapping, and the atomic write.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handle(req, undefined, (c) => container().http.identity.completeProfile(c));
}
