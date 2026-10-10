// The company inbox (PRD-04 X-9, X-10, D-47) — one function per operationId:
// listRequestsForMe ("Requests for you"), listOpenRequests ("Open requests
// near you"), declineRfpInvitation.
//
// Tendering owns both lists (they are RFPs and invites). What it does NOT own
// comes through published ports, injected at the composition root:
//   directory.biddingProfileOf(orgId) — the company's specialty family, base
//     point, service radius and areas (the directory's profile);
//   builds.factsOf(projectIds) — each build's name, municipality and point
//     (the project module), used to name the build and to measure distance.
// Only the distance leaves the server, never the build's point.
import { ProblemError } from '../../../platform/errors.mjs';
import { companyRequestBody, matchOpenRequest, openRequestBody } from '../domain/bid-requests.mjs';
import { requireActor, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_REQUESTS_MAX = 100;

function requireBidder(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
}

/** operationId: listRequestsForMe — every invite of my org, newest first. */
export async function listRequestsForMe({ viewer, store, builds, query }) {
  requireBidder(viewer);
  const cursor = decodeCursor(query?.cursor);
  const { items, nextCursor } = await store.requestsForOrg(viewer.orgId, { cursor, limit: clampLimit(query?.limit) });
  const named = await buildsById(builds, items.map((r) => r.project_id));
  return {
    status: 200,
    body: {
      items: items.map((r) => companyRequestBody(r, named.get(r.project_id))),
      next_cursor: nextCursor ? encodeCursor(nextCursor) : null,
    },
  };
}

/** operationId: listOpenRequests — listed RFPs matching my directory profile, nearest first. */
export async function listOpenRequests({ viewer, store, directory, builds }) {
  requireBidder(viewer);
  const profile = directory ? await directory.biddingProfileOf(viewer.orgId) : null;
  if (!profile?.listed) return { status: 200, body: { items: [], profile_missing: true } };

  const candidates = await store.listedOpenRfps({ orgId: viewer.orgId });
  const named = await buildsById(builds, candidates.map((r) => r.project_id));
  const matched = [];
  for (const rfp of candidates) {
    const build = named.get(rfp.project_id) ?? null;
    const { match, distance_km: distanceKm } = matchOpenRequest({ specialtyCodes: rfp.specialty_codes }, build, profile);
    if (match) matched.push({ rfp, build, distanceKm });
  }
  matched.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)
    || String(a.rfp.submission_deadline).localeCompare(String(b.rfp.submission_deadline)));
  const page = matched.slice(0, OPEN_REQUESTS_MAX);
  const mine = new Map((await store.bidRequestsOfOrg(viewer.orgId, page.map((m) => m.rfp.id))).map((r) => [r.rfp_id, r]));
  return {
    status: 200,
    body: {
      items: page.map(({ rfp, build, distanceKm }) => openRequestBody(rfp, { build, distanceKm, myRequest: mine.get(rfp.id) ?? null })),
      profile_missing: false,
    },
  };
}

/** operationId: declineRfpInvitation — the company will not bid. */
export async function declineRfpInvitation({ viewer, store, builds, rfpId }) {
  requireBidder(viewer);
  if (!UUID.test(rfpId ?? '')) throw new ProblemError('not_found');
  const invite = await store.invitationOf(rfpId, viewer.orgId);
  if (!invite) throw new ProblemError('not_found');
  const rfp = await store.getRfp(rfpId);
  if (invite.status !== 'declined') {
    if (rfp.status !== 'published') throw new ProblemError('invalid_transition', `cannot decline a ${rfp.status} RFP`);
    if (!['invited', 'draft'].includes(invite.lane_status)) {
      throw new ProblemError('invalid_transition', 'your proposal is already in — withdraw it instead');
    }
    const actor = await requireActor(store, viewer);
    await store.declineInvitation({ rfpId, recipientId: invite.id, projectId: rfp.project_id, actor: actorOf(actor, viewer) });
  }
  const row = await store.requestForOrg(rfpId, viewer.orgId);
  const named = await buildsById(builds, [rfp.project_id]);
  return { status: 200, body: companyRequestBody(row, named.get(rfp.project_id)) };
}

async function buildsById(builds, projectIds) {
  const ids = [...new Set(projectIds)];
  if (!builds || !ids.length) return new Map();
  return new Map((await builds.factsOf(ids)).map((b) => [b.project_id, b]));
}

function encodeCursor({ at, id }) {
  const t = at instanceof Date ? at.toISOString() : String(at);
  return Buffer.from(`${t}|${id}`).toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  const [at, id] = Buffer.from(String(raw), 'base64url').toString().split('|');
  if (!UUID.test(id ?? '') || Number.isNaN(Date.parse(at ?? ''))) {
    throw new ProblemError('validation_failed', null, { errors: { cursor: 'not a cursor from this list' } });
  }
  return { at, id };
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}
