// The portfolio home's data layer, on `/api/v2` (LINA-311, S1 of the UI cutover,
// doc 22 §3). This is the FIRST surface to read through the shared v2 client
// (`./client.ts`, LINA-309) — it proves the path end-to-end for S2–S7.
//
// ── WHAT CHANGED FROM v1 ─────────────────────────────────────────────────────
// The v1 home read (`lib/api.ts::getMe` + `listProjects`) is keyed on
// `identity.party` (by email). v2 is a different identity space: `identity.person`
// (by Clerk user id, filled by the webhook mirror) acting inside an
// `identity.organization`. The access rule is org-centric — `listProjects` scopes
// to the viewer's ACTIVE org — so two facts have no v1 analog and are handled as
// first-class states here, never as errors that reach the render:
//
//  • Not mirrored yet — a signed-in Clerk user whose person row the webhook has
//    not written. `viewerFromClerk()` fails closed (personId stays null, Gate A),
//    so `/me` 404s and `/projects` denies. We map that to an EMPTY portfolio and a
//    null profile, never a leak and never a crash.
//  • Signed in, no active org — a person with no organisation selected. v2's
//    `listProjects` requires an active org (doc 16 §4); with none, the honest
//    answer is "no builds", which under B2 (fresh start, LINA-310) is exactly the
//    empty-portal UX this slice targets.
//
// Both collapse to the same screen: `<EmptyPortal/>`. That is deliberate — under
// B2 there is no migrated portfolio to render, so "nothing to show" is the norm,
// not an exception.
//
// The pure wire→view transforms live in `./profile-view.ts` so they stay
// unit-testable without a session; this module is only the I/O and the
// fail-closed error handling.
import 'server-only';

import { v2, V2Error } from './client';
import type { PortalUser } from '@/components/PortalShell';
import type { ProjectSummary } from '@/lib/types';
import {
  toPortalUser, toProjectSummary,
  type V2Me, type V2ProjectList,
} from './profile-view';

/**
 * GET /api/v2/me → the account-menu identity, or null when the viewer has no
 * resolvable v2 profile (not mirrored yet). Fail-closed: a 404/403/401 is not a
 * crash, it is "we cannot name you yet" and the caller shows a neutral shell.
 */
export async function getViewerProfile(): Promise<PortalUser | null> {
  try {
    const me = await v2<V2Me>({ method: 'GET', path: '/me' });
    return toPortalUser(me);
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / not signed in — no leak
    throw err;
  }
}

/**
 * GET /api/v2/me → does the viewer have an ACTIVE organisation? The v2 tendering
 * reads are org-scoped, so a surface that renders `<ProcurementSection>` needs to
 * tell "no org selected" (a first-class neutral state, LINA-310) apart from "org
 * with no tenders" — a distinction an empty RFP list cannot make on its own.
 * Fail-closed: not mirrored / not signed in / any V2Error → false (no org).
 */
export async function viewerHasActiveOrg(): Promise<boolean> {
  try {
    const me = await v2<V2Me>({ method: 'GET', path: '/me' });
    return me.active_org != null;
  } catch (err) {
    if (err instanceof V2Error) return false; // no mirror / no session — treat as no org
    throw err;
  }
}

/**
 * GET /api/v2/projects → the acting org's portfolio, membership-scoped
 * server-side (the viewer's active org, never a client-held id). Returns [] for a
 * viewer with no active org or no mirror row — the B2 empty-portal state, which is
 * the norm under fresh start, not an error.
 */
export async function listPortfolio(): Promise<ProjectSummary[]> {
  let me: V2Me | null = null;
  try {
    me = await v2<V2Me>({ method: 'GET', path: '/me' });
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
  }
  // No active org → nothing to scope a portfolio to. Skip the /projects read: it
  // would only deny, and an empty portfolio is the correct, non-leaking answer.
  if (!me?.active_org) return [];

  try {
    const list = await v2<V2ProjectList>({ method: 'GET', path: '/projects' });
    return list.items.map((o) => toProjectSummary(o, me!.active_org!.kind));
  } catch (err) {
    if (err instanceof V2Error) return []; // fail-closed: denied → empty, never a crash
    throw err;
  }
}
