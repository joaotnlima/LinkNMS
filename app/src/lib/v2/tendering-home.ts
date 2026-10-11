// The tendering home + clarifications data layer (PRD-08). ONLY I/O and the
// fail-closed handling; the wire→view phrasing lives in `tendering-home-view.ts`.
// Every call goes through the one shared v2 seam (LINA-309).
//
//   listProjectRfps     — GET  /projects/{projectId}/rfps (the home, one read)
//   askClarification    — POST /rfps/{rfpId}/clarifications (an invited org)
//   answerClarification — POST /clarifications/{id}:answer (the issuer; to all bidders)
import 'server-only';
import { randomUUID } from 'node:crypto';

import { allPages } from './pages';
import { v2, V2Error } from './client';
import type { V2Clarification } from './tendering-view';
import type { V2ProjectRfp } from './tendering-home-view';

/**
 * The project's tendering home, or null when the viewer may not see it (not a
 * participant and not a bidder: the module answers 404 — existence hiding).
 */
export async function listProjectRfps(projectId: string): Promise<V2ProjectRfp[] | null> {
  try {
    return await allPages<V2ProjectRfp>({ path: `/projects/${encodeURIComponent(projectId)}/rfps` });
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

/** Ask the issuer (H-6). Refused by the server after the questions deadline (H-9). */
export async function askClarification(rfpId: string, question: string): Promise<V2Clarification> {
  return v2<V2Clarification>({
    method: 'POST',
    path: `/rfps/${encodeURIComponent(rfpId)}/clarifications`,
    body: { id: randomUUID(), question },
  });
}

/** Answer for every bidder (H-7/H-8). */
export async function answerClarification(clarificationId: string, answer: string): Promise<V2Clarification> {
  return v2<V2Clarification>({
    method: 'POST',
    path: `/clarifications/${encodeURIComponent(clarificationId)}:answer`,
    body: { answer },
  });
}
