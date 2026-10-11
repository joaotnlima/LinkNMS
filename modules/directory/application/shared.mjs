// Directory application — guards shared by the use cases.
//
// Access (doc 16 conjunction): the company-side operations need
// `org:profile:manage` AND the path org to be the session's ACTIVE org — a
// profile is the organisation's own (D-19). The public reads take an optional
// viewer: anonymous visitors are welcome (PRD-03 R-9), a signed-in viewer only
// adds what its relationships allow (near_project) and is never counted as a
// view of its own profile.
import { ProblemError } from '../../../platform/errors.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireSession(viewer) {
  if (!viewer) throw new ProblemError('unauthenticated', 'sign in first');
}

export function requireActiveOrg(viewer) {
  requireSession(viewer);
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

/** The company side: own org ∧ org:profile:manage. */
export function requireOwnProfileOrg(viewer, orgId) {
  requireActiveOrg(viewer);
  if (!UUID.test(orgId ?? '') || orgId !== viewer.orgId) {
    throw new ProblemError('forbidden', 'a profile is edited by its own organisation', { reason: 'relationship' });
  }
  if (!viewer.has('org:profile:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
}

/** x-human-only (doc 19): never reachable through MCP. */
export function requireHuman(viewer, what) {
  if (viewer?.channel === 'mcp') throw new ProblemError('forbidden', `${what} is human-only`, { reason: 'human_only' });
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Comma-separated query value → trimmed, de-duplicated list. */
export function listParam(raw) {
  if (raw == null || raw === '') return [];
  return [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))];
}
