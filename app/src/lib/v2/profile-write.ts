// The onboarding profile WRITE on `/api/v2` (LINA-385, Phase 12b.6) — the I/O
// half. The pure field mapping lives in `./profile-edit.ts` (unit-tested without
// a session); this module is only the I/O: translate → PUT through the shared v2
// client (`./client.ts`, the single UI↔/api/v2 seam — never a second one).
//
// Like the org-provisioning seam (`./org.ts`) and unlike the READ seams, this
// RETHROWS: a person who cannot save their profile should learn why, not get a
// silent success. The calling server action (`onboarding/actions.ts`) maps the
// `V2Error` — in particular `version_conflict` while the sign-up mirror is still
// catching up — to the onboarding messaging (retry on mirror lag).
import 'server-only';

import { v2 } from './client';
import { toProfileUpdateBody, type ProfileEditInput } from './profile-edit';

/** The `Person` fields we read back off the 200 — only the id, as proof of write. */
interface V2PersonResponse {
  id: string;
}

/**
 * Save the acting person's display name + language via `PUT /api/v2/me/profile`.
 * Identity is the verified session's person (server-derived, never the body):
 * the endpoint keys the write on the viewer's Clerk user id.
 */
export async function saveMyProfileV2(input: ProfileEditInput): Promise<void> {
  const body = toProfileUpdateBody(input);
  await v2<V2PersonResponse>({ method: 'PUT', path: '/me/profile', body });
}
