// The v2 ORG-PROVISIONING field mapping (LINA-365 increment 2, the identity half
// of the LINA-309 write cutover) — the PURE half, kept free of `server-only`/
// `./client` so it is unit-testable without a Clerk session (same split as
// `build-create.ts` ↔ `build.ts`). The I/O wrapper that mints the id and POSTs
// lives in `./org.ts`.
//
// ── WHY THIS SEAM EXISTS ──────────────────────────────────────────────────────
// Every v2 write is gated on an ACTIVE v2 org: `createProject` runs
// `requireActiveOrg(viewer)` + `org:projects:create` (modules/project
// use-cases). Today the FE provisions NO v2 org — `onboarding/setup` writes only
// the v1 profile (`/api/v1/me/profile`) — so a fresh signed-in user has no active
// org and the build-creation seam (`createBuildDraftV2`) would 403. This is the
// upstream unblock: turn the onboarding role choice into a `POST /organizations`
// (which creates the Clerk org AND mirrors it inline, per the v2 spec), so the
// viewer resolves an active org and the read-cuts finally observe real data.
//
// ── THE ONBOARDING → v2 ORGANIZATION MAPPING (the contract this pins down) ─────
//   onboarding field        → v2 OrganizationCreate (openapi `POST /organizations`)
//   ─────────────────────────────────────────────────────────────────────────
//   role 'owner'            → kind 'household'
//   role 'general_contractor' → kind 'contractor'
//   (client-minted)         → id                (UUID, minted in org.ts —
//                                                 v2 is client-generated-id)
//   displayName             → legal_name        (required, trimmed)
//
// DELIBERATELY NOT SENT (and why):
//   • nif — the Portuguese tax id is optional on v2 and the onboarding screen
//     does not collect it; it is captured later on the org profile
//     (`PUT /organizations/{id}/profile`), not at first provisioning. Sending a
//     blank would be a placeholder in a record whose whole promise is truth.
//   • approval_policy — optional; v2 defaults it. A household (single decision
//     maker) and a fresh contractor org both start on the server default; the
//     policy is an org-settings concern, not a provisioning-time one.
//
// ── GAPS raised to the wiring increment (do not paper over here) ──────────────
//   GAP-3  Only 'owner' and 'general_contractor' are reachable from the pen
//          onboarding today. The v2 `kind` enum also has 'consultant' and
//          'supplier'; those personas provision through their own (future) entry
//          points, not this screen. An unmapped role is a defect here, not a
//          silent default — it throws.
import type { OnboardingRole } from './org';

/** The v2 org `kind` enum, exactly as openapi `POST /organizations` accepts. */
export type OrganizationKind = 'household' | 'contractor' | 'consultant' | 'supplier';

/** The onboarding inputs to a fresh org, pre-translation. */
export interface OrgProvisionInput {
  /**
   * The role the person picked on `onboarding/setup`. Only 'owner' and
   * 'general_contractor' are reachable from that screen today (GAP-3).
   */
  role: OnboardingRole;
  /**
   * How the person named themselves on the record → the org `legal_name`.
   * Required; trimmed. A blank value is a programmer error here (the form must
   * validate first) and throws.
   */
  displayName: string;
}

/** The `OrganizationCreate` wire body, exactly as openapi requires. Only the
 *  fields this seam sends — no nif, no approval_policy (server defaults). */
export interface OrganizationCreateBody {
  id: string;
  kind: OrganizationKind;
  legal_name: string;
}

/** The onboarding role → v2 org kind mapping. The single place this translation
 *  lives, so a drift is reviewable in one diff. Throws on a role with no v2 kind
 *  (GAP-3) rather than silently defaulting to 'household'. */
export function kindForRole(role: OnboardingRole): OrganizationKind {
  switch (role) {
    case 'owner':
      return 'household';
    case 'general_contractor':
      return 'contractor';
    default: {
      // Exhaustiveness: if OnboardingRole grows a value with no mapping, this is
      // a compile error at the call sites and a throw at runtime — never a
      // silent wrong-kind org on the record.
      const unmapped: never = role;
      throw new Error(`no v2 organization kind for onboarding role: ${String(unmapped)}`);
    }
  }
}

/**
 * Pure onboarding-input → `OrganizationCreate` body, with the id already minted.
 * Throws on a blank display name: it is required by v2 and the form is expected
 * to have validated it, so reaching here blank is a defect, not a user error to
 * render.
 */
export function toOrganizationCreateBody(input: OrgProvisionInput, id: string): OrganizationCreateBody {
  const legalName = input.displayName?.trim();
  if (!legalName) throw new Error('display name is required');
  return { id, kind: kindForRole(input.role), legal_name: legalName };
}
