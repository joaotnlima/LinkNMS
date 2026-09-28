// The project-phase + execution sign-off I/O layer, on `/api/v2` (LINA-323, S6 of
// the UI cutover, doc 22 §3). Reads the phase list (with its sign-off history) and
// resolves the acting person, so the plan surface can render the SignOffPanel and
// lock the grid once a plan is sent for sign-off.
//
// The WRITES (request / approve / reject) do NOT go through this server module:
// the SignOffPanel is a Client Component and posts them straight to the
// `/api/v2/projects/{id}/phases/{phaseId}/sign-off[...]` route from the browser,
// exactly as it posted to the v1 routes before the cut (only the base path moved).
// Keeping the writes on the client preserves the panel's optimistic busy/refresh
// flow and its "nothing was recorded" guard unchanged; this module is the READ
// half the server component needs to render the initial state.
//
// ── FIRST-CLASS EMPTY / NO-ORG STATES (doc 22 header + the S1 pattern) ────────
// The v2 access model is org-centric: a signed-in Clerk user with no mirror row,
// no active org, or who is not a participant on this build must NOT crash the plan
// page — those are ordinary states of a fresh B2 install (LINA-310). As in
// `planning.ts`, any `V2Error` collapses to NO phases (the panel then renders
// nothing, and the grid is simply editable) rather than a stack trace. A non-V2
// error (a real bug) is rethrown — we fail closed on authorization, not on defects.
//
// The pure wire→view transforms live in `./phases-view.ts` so they stay
// unit-testable without a session; this module is only the I/O and the
// fail-closed handling.
import 'server-only';

import { v2, V2Error } from './client';
import { toPhase, type V2Phase, type V2WirePhase } from './phases-view';
import type { V2Me } from './profile-view';

/**
 * GET /api/v2/projects/{id}/phases → the project's phases (Procurement seq 0,
 * Execution seq 1), each with its sign-off history. The BE lazy-seeds the two
 * default phases on first read (listPhases, phases.mjs), so a fresh build returns
 * them rather than an empty list. Fail-closed to `[]` for any authorization
 * failure — a viewer who cannot read phases sees no sign-off controls, never a
 * crash and never another org's phases.
 */
export async function getPhasesV2(projectId: string): Promise<V2Phase[]> {
  try {
    const { phases } = await v2<{ phases: V2WirePhase[] }>({
      method: 'GET',
      path: `/projects/${projectId}/phases`,
    });
    return phases.map(toPhase);
  } catch (err) {
    if (err instanceof V2Error) return []; // no access / not a participant — not a crash
    throw err;
  }
}

/**
 * GET /api/v2/me → the acting person's id, or null when the viewer has no
 * resolvable v2 profile (not mirrored yet). This is the id the sign-off requests
 * are keyed on (`requested_by` = actor.id, phases.mjs), so the panel can tell "I
 * asked for this" (can't self-approve) from "they did" (I may decide). Fail-closed
 * to null: an unresolved viewer simply gets no decision controls.
 */
export async function getViewerPersonId(): Promise<string | null> {
  try {
    const me = await v2<V2Me>({ method: 'GET', path: '/me' });
    return me.person?.id ?? null;
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / not signed in
    throw err;
  }
}
