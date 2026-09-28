'use server';

// v2 organization provisioning for the onboarding flow (LINA-365, the identity
// half of the LINA-309 write cutover).
//
// WHY A DEDICATED 'use server' FILE (not app/actions.ts): this is the only entry
// point that reaches the `server-only` v2 seam (`@/lib/v2/org`). Keeping it in its
// own module — imported by nothing but `onboarding/setup` — keeps the server-only
// import off the big shared actions module and its many client importers, so the
// blast radius of this cutover is exactly the onboarding screen.
//
// WHAT THIS DOES: turns the role the person picked into a real v2 organization
// (`POST /api/v2/organizations`), which creates the Clerk org AND mirrors it, with
// the acting user enrolled as its admin. It returns a coarse result — NOT the
// Clerk org id — because the caller learns that id from Clerk directly (the POST
// response deliberately omits it) and then `setActive`s it in the browser session.
//
// FAIL SOFT, NOT SILENT: a fresh signup can reach onboarding SECONDS before the
// Clerk→v2 `user.created` webhook lands the person mirror, so `requirePerson`
// answers `version_conflict` ("your identity mirror has not caught up yet —
// retry"). That is a transient, retryable state, distinguished here by `code:
// 'mirror_lag'` so the client can back off and retry rather than strand the user.
import { provisionOrgV2, type OnboardingRole } from '@/lib/v2/org';
import { V2Error } from '@/lib/v2/client';

export interface ProvisionOrgResult {
  ok: boolean;
  /**
   * Stable discriminator for the client:
   *   'mirror_lag' — the person mirror has not caught up; retry.
   *   'forbidden'  — a real authorization refusal; do not retry.
   *   'error'      — anything else.
   */
  code?: 'mirror_lag' | 'forbidden' | 'error';
  message?: string;
}

/**
 * Provision the person's household/company on v2. Never throws: onboarding must
 * not be stranded by a provisioning hiccup, so every failure is a typed result
 * the client can react to (retry on `mirror_lag`, proceed best-effort otherwise).
 */
export async function provisionOnboardingOrg(
  input: { role: OnboardingRole; displayName: string },
): Promise<ProvisionOrgResult> {
  try {
    await provisionOrgV2({ role: input.role, displayName: input.displayName });
    return { ok: true };
  } catch (err) {
    if (err instanceof V2Error) {
      // requirePerson (modules/identity) throws `version_conflict` while the
      // Clerk→v2 person mirror is still catching up — transient, retryable.
      if (err.code === 'version_conflict') return { ok: false, code: 'mirror_lag', message: err.message };
      if (err.status === 403 || err.code === 'forbidden') return { ok: false, code: 'forbidden', message: err.message };
    }
    return {
      ok: false,
      code: 'error',
      message: err instanceof Error ? err.message : 'Could not set up your organization.',
    };
  }
}
