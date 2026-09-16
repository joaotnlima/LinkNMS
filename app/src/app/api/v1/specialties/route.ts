// GET  /api/v1/specialties — the caller's pickable trade list (system ∪ own)
// POST /api/v1/specialties — create one on the fly, body { label }
//
// The specialty catalog (LINA-306 item 6) is per-USER and project-independent —
// a suggest list behind the plan grid's "Specialty" chip — so it lives at the
// top level next to /api/v1/me, NOT under /projects/:id. It carries no audit
// weight (ADR-0002): the chosen label is still stored free-form on the stage;
// this only powers the picker and remembers what a party has typed so it is
// offered on their next build ("available cross projects").
//
// Like every route under api/v1, this holds NO domain logic: `handle()` resolves
// the acting party from the verified Clerk session (ADR-0004 — never from the
// body, so a forged owner is inert) and the schedule service owns validation and
// the idempotent create.
import { handle, container } from '@/server/gateway';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return handle(req, undefined, (c) => container().http.schedule.listSpecialties(c));
}

export function POST(req: Request) {
  return handle(req, undefined, (c) => container().http.schedule.createSpecialty(c));
}
