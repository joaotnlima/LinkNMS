// The invitation accept deep-link, on /api/v2 (LINA-398 — replacing the retired
// v1 identity invitation slice). Server-only I/O; imports `server-only`
// transitively through the v2 client, so a client component must never import
// this.
//
// The PREVIEW is the one `security: []` read here: the viewer is null and
// `allowAnonymous` is set, so the v2 client dispatches WITHOUT resolving a Clerk
// session (client.ts §callInProcess) — the token in the path IS the credential,
// re-supplied on the call, and the backend read is anti-oracle (unknown ⇄ spent
// ⇄ expired all 404 identically). The ACCEPT, by contract, needs a verified
// session: no `allowAnonymous`, so an anonymous caller is a clean 401 before the
// round trip, and the acting party comes from the session, never the token
// (ADR-0004). A token alone can never put a stranger on a record.
import 'server-only';

import { v2 } from './client';

/**
 * The v2 participation capacity an invitation carries (project.project_invitation
 * CHECK): a consultant engaged without a priced contract. This replaces the v1
 * `Role` the retired `identity.invitation` returned — that table pinned role to
 * `counterparty`, a concept the v2 model expresses through contracts, not
 * invitations.
 */
export type InviteCapacity = 'design' | 'inspection' | 'safety' | 'other';

/**
 * The unauthenticated preview behind the Band B accept deep link (M6/D6). Served
 * to a signed-out visitor holding only the token, so it carries which build they
 * were invited to, who invited them, and in what capacity — and nothing else.
 */
export interface InvitationPreview {
  projectName: string | null;
  invitedByName: string | null;
  capacity: InviteCapacity;
}

// The wire shape the backend returns (snake_case, platform convention).
interface InvitationPreviewBody {
  project_name: string | null;
  invited_by_name: string | null;
  capacity: InviteCapacity;
}

const enc = (token: string) => encodeURIComponent(token);

/**
 * The accept deep link's UNAUTHENTICATED read. Unknown and already-used tokens
 * both 404 identically and the endpoint is rate-limited server-side; it must
 * never be treated as a token-validity oracle. Callers swallow the 404 into the
 * generic landing copy — the accept POST re-verifies the token regardless.
 */
export async function getInvitationPreview(token: string): Promise<InvitationPreview> {
  const body = await v2<InvitationPreviewBody>({
    method: 'GET',
    path: `/project-invitations/${enc(token)}`,
    allowAnonymous: true,
  });
  return {
    projectName: body.project_name,
    invitedByName: body.invited_by_name,
    capacity: body.capacity,
  };
}

/**
 * Accept the invitation with the acting party's active org. Requires a session
 * (no `allowAnonymous`): the token proves the invitation, the session says who
 * joins. Returns the project to redirect into.
 */
export async function acceptInvitation(token: string): Promise<{ projectId: string }> {
  const body = await v2<{ project_id: string }>({
    method: 'POST',
    path: `/project-invitations/${enc(token)}:accept`,
  });
  return { projectId: body.project_id };
}

/** Human label for an invitation capacity — the accept landing's "Your role" row. */
export function capacityLabel(capacity: InviteCapacity): string {
  switch (capacity) {
    case 'design': return 'Design consultant';
    case 'inspection': return 'Inspector';
    case 'safety': return 'Health & safety';
    default: return 'Consultant';
  }
}
