// Organization PROVISIONING on `/api/v2` (LINA-365 increment 2, the identity half
// of the LINA-309 UI write cutover, doc 22 §3 + to-be/16). This is the seam the
// onboarding flow writes through once identity moves off v1: it turns the role
// the person picked into a real v2 org so every later v2 write has an active org
// to resolve. The pure field mapping lives in `./org-provision.ts` (unit-tested
// without a session); this module is only the I/O — mint the id, POST, read back.
//
// ── WHY A SEPARATE SEAM, AND WHY A BRICK FIRST ───────────────────────────────
// The read cuts (S1 portfolio, S2 record, S3 plan) and the creation seam
// (`createBuildDraftV2`) all sit over an EMPTY v2 store because no signed-in user
// has a v2 org yet. This module is the upstream unblock; it lands as a tested
// brick (the LINA-320 / build.ts pattern) and is WIRED into `onboarding/setup`
// by the increment that also flips the build wizard to v2, so identity + creation
// land together and a fresh user can actually reach a created project.
//
// ── GATE (why this brick is not yet wired, and the founder step it needs) ────
// `POST /api/v2/organizations` requires the acting PERSON to already be mirrored
// into v2 (`requirePerson`, modules/identity use-cases). Persons are mirrored by
// the Clerk→v2 webhook (`POST /api/v2/webhooks/clerk`, `user.*` events). As of
// 2026-09-28 that endpoint answers `svix: no signing secret configured` on BOTH
// prod and dev — `CLERK_WEBHOOK_SIGNING_SECRET` is unset and Clerk is not
// configured to deliver to the v2 path. Until a founder provisions that secret
// and points the Clerk webhook at `/api/v2/webhooks/clerk` (Svix is dashboard-
// only; an agent cannot self-provision it — cf. LINA-166 / LINA-135), this call
// would fail `requirePerson` for every real user. Wiring onboarding to this seam
// is gated on that config step. See the LINA-365 / LINA-309 thread.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2 } from './client';
import { toOrganizationCreateBody, type OrgProvisionInput } from './org-provision';

export type { OrgProvisionInput, OrganizationCreateBody, OrganizationKind } from './org-provision';
export { toOrganizationCreateBody, kindForRole } from './org-provision';

/**
 * The onboarding role the person picks on `onboarding/setup`. Only these two are
 * reachable from that screen today; the v2 `kind` enum is wider (consultant,
 * supplier) and those personas provision through their own entry points (GAP-3).
 */
export type OnboardingRole = 'owner' | 'general_contractor';

/** The `Organization` fields we read back off the 201 — only the id the caller
 *  needs to then `setActive` it in the Clerk session. */
interface V2OrganizationResponse {
  id: string;
}

/**
 * Create the person's company or household on v2 and return its id. Mints the
 * client-side org UUID (v2 is client-generated-id) and uses it AS the
 * `Idempotency-Key`, so a retried submit — a double-tap, a server-action replay —
 * is a proven no-op that returns the same org, never a second one.
 *
 * Like the creation seam (and unlike the READ seams, which fail-closed to empty),
 * this RETHROWS: a person who cannot provision must see the refusal, not a silent
 * success onto an empty store. The calling flow maps the `V2Error` — in
 * particular the `requirePerson` 403 while the identity mirror is dark (see the
 * GATE note) — to the onboarding messaging.
 */
export async function provisionOrgV2(input: OrgProvisionInput): Promise<{ id: string }> {
  const id = randomUUID();
  const body = toOrganizationCreateBody(input, id);
  const org = await v2<V2OrganizationResponse>({
    method: 'POST',
    path: '/organizations',
    body,
    idempotencyKey: id,
  });
  return { id: org.id };
}
