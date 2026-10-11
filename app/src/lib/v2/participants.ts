// The participants page's data layer on `/api/v2` (PRD-09 O-3, O-4). I/O only;
// naming lives in `./participants-view.ts`. Reads fail closed (an empty list);
// the invite rethrows so the action can say why.
import 'server-only';

import { v2, V2Error } from './client';
import type { InviteBody, V2Participant, V2ProjectInvitation } from './participants-view';

const enc = encodeURIComponent;

async function itemsOrEmpty<T>(p: Promise<{ items: T[] }>): Promise<T[]> {
  try {
    return (await p).items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

export function listParticipants(projectId: string): Promise<V2Participant[]> {
  return itemsOrEmpty(v2<{ items: V2Participant[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/participants`, query: { limit: 200 } }));
}

/** The invitations MY organisation sent on this build (never anyone else's). */
export function listMyInvitations(projectId: string): Promise<V2ProjectInvitation[]> {
  return itemsOrEmpty(v2<{ items: V2ProjectInvitation[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/invitations`, query: { limit: 200 } }));
}

/** The PartyInvite. Answers the invitation with its one-time token. */
export function inviteParty(projectId: string, body: InviteBody): Promise<V2ProjectInvitation> {
  return v2<V2ProjectInvitation>({ method: 'POST', path: `/projects/${enc(projectId)}/invitations`, body });
}
