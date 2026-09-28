// Build (project) CREATION on `/api/v2` (LINA-365, the write half of the LINA-309
// UI cutover, doc 22 §3). This is the v2 twin of `lib/api.ts::createBuildDraft`:
// the seam the build-creation wizard writes through once creation moves off v1.
// The pure field mapping lives in `./build-create.ts` (unit-tested without a
// session); this module is only the I/O — mint the id, POST, read back the id.
//
// ── WHY A SEPARATE SEAM, AND WHY A BRICK FIRST ───────────────────────────────
// The read cuts (S1 portfolio, S2 record, S3 plan) all landed observing an EMPTY
// v2 store, because every write still goes to `/api/v1` (`createBuildDraft` →
// `identity.createProject`). Until a project is *created* on v2 the read cuts are
// correct-but-unobservable. This module is the creation write; it lands as a
// tested brick (the LINA-320 pattern) and is WIRED into the wizard by the
// increment that also provisions the v2 org (see the GATE note), so the two land
// together and a fresh user can actually reach a 201.
//
// ── GATE (why this brick is not yet wired) ───────────────────────────────────
// v2 `createProject` requires an ACTIVE v2 org with `org:projects:create`
// (modules/project use-cases: `requireActiveOrg` + the permission), resolved from
// the Clerk session by `server/v2/viewer.ts`. Today no FE flow provisions a v2
// org (onboarding/setup writes only the v1 profile), so a fresh signed-in user
// has no active org and this call would 403. Wiring the wizard to this seam is
// gated on the org-provisioning increment. See the LINA-365 thread.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2 } from './client';
import { toProjectCreateBody, type BuildDraftV2Input } from './build-create';

export type { BuildDraftV2Input, ProjectCreateBody } from './build-create';
export { toProjectCreateBody } from './build-create';

/** The `Project` fields we read back off the 201 — only the id the wizard needs
 *  to route to the next step. */
interface V2ProjectResponse {
  id: string;
}

/**
 * Create a build (draft brief) on v2 and return its id. Mints the client-side
 * project UUID (v2 is client-generated-id) and uses it AS the `Idempotency-Key`,
 * so a retried submit — a double-tap, a server-action replay — is a proven no-op
 * that returns the same project, never a second build.
 *
 * Unlike the READ seams (which fail-closed to empty on any `V2Error`), this
 * RETHROWS: a viewer who cannot create must see the refusal, not a silent
 * success. The calling server action maps the `V2Error` to the form's messaging,
 * exactly as `createBuildAction` already does for the v1 `ApiError`.
 */
export async function createBuildDraftV2(input: BuildDraftV2Input): Promise<{ id: string }> {
  const id = randomUUID();
  const body = toProjectCreateBody(input, id);
  const project = await v2<V2ProjectResponse>({
    method: 'POST',
    path: '/projects',
    body,
    idempotencyKey: id,
  });
  return { id: project.id };
}
