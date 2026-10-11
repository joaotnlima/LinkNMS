// Tendering domain — asking to bid on a listed RFP and the company inbox
// (PRD-04 X-3, X-5, X-9, X-10, X-13; D-47). Pure, no I/O.
//
// THE RULE (D-47, founder 2026-10-10). A listed RFP is an OPEN REQUEST shown
// to companies whose specialty and service area match. A company only ASKS to
// bid; it gets no lane and no personal link until the issuer approves. The
// decision is the issuer's, once: pending → approved | declined.

export const BID_REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'declined']);
export const RECIPIENT_SOURCES = Object.freeze(['directory', 'email', 'asked_to_bid']);

/** May a company ask to bid on this RFP right now? → { ok } | { ok:false, code, reason }. */
export function askable(rfp, { orgId, now = new Date() }) {
  // Not listed, not published, or unknown: the same 404 (no existence oracle, V8).
  if (!rfp || !rfp.listed || rfp.status !== 'published') return { ok: false, code: 'not_found' };
  if (rfp.issuer_org_id === orgId) {
    return { ok: false, code: 'validation_failed', reason: 'the issuer cannot ask to bid on its own RFP' };
  }
  if (new Date(rfp.submission_deadline) <= now) {
    return { ok: false, code: 'invalid_transition', reason: 'the submission deadline has passed' };
  }
  return { ok: true };
}

/** The issuer's decision on a request: only a pending one, only while bidding is open. */
export function decidable(request, rfp, decision) {
  if (request.status !== 'pending') {
    return { ok: false, reason: `this request was already ${request.status}` };
  }
  if (decision === 'approve' && rfp.status !== 'published') {
    return { ok: false, reason: `cannot add a bidder to a ${rfp.status} RFP` };
  }
  return { ok: true };
}

// ── matching an open request to a company (X-10) ────────────────────────────

const EARTH_KM = 6371;

/** Great-circle distance in km (the directory's distance_km, same formula). */
export function haversineKm(a, b) {
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Does a listed RFP match a company's directory profile?
 *   specialty — an RFP code in the profile's family set (the directory port
 *               expands each of the company's codes to itself, its parent and
 *               its children);
 *   area      — the build within the company's service radius of its base
 *               point, else the build's municipality (or its district, the
 *               first two digits) among the company's service areas.
 * Returns { match, distance_km } — distance only when both points are known.
 */
export function matchOpenRequest({ specialtyCodes }, build, profile) {
  const family = new Set(profile?.specialty_family ?? []);
  const specialty = (specialtyCodes ?? []).some((c) => family.has(c));
  if (!specialty || !build) return { match: false, distance_km: null };
  let distance = null;
  if (build.lat != null && profile.base?.lat != null) {
    distance = haversineKm({ lat: build.lat, lng: build.lng }, profile.base);
  }
  const inRadius = distance != null && profile.radius_km != null && distance <= Number(profile.radius_km);
  const areas = profile.service_areas ?? [];
  const muni = build.municipality_code ?? null;
  const inArea = muni != null && (areas.includes(muni) || areas.includes(muni.slice(0, 2)));
  return { match: inRadius || inArea, distance_km: distance == null ? null : Math.round(distance * 10) / 10 };
}

// ── wire (api/v2 components/schemas) ────────────────────────────────────────

/** #/components/schemas/BidRequest. `company` only for the issuer's list. */
export function bidRequestBody(row, { company = null, issuer = false } = {}) {
  return {
    id: row.id,
    rfp_id: row.rfp_id,
    org_id: row.org_id,
    status: row.status,
    requested_at: iso(row.requested_at),
    decided_at: iso(row.decided_at),
    ...(issuer && row.decided_by_person_id ? { decided_by_person_id: row.decided_by_person_id } : {}),
    ...(row.recipient_id ? { recipient_id: row.recipient_id } : {}),
    ...(company ? { company } : {}),
  };
}

/** #/components/schemas/CompanyRequest — one invite in "Requests for you". */
export function companyRequestBody(row, build = null) {
  return {
    rfp_id: row.rfp_id,
    recipient_id: row.recipient_id,
    title: row.title,
    origin: row.source,
    issuer_level: row.level,
    ...(build ? { build: { name: build.name, ...(build.municipality_code ? { municipality_code: build.municipality_code } : {}) } } : {}),
    rfp_status: row.rfp_status,
    submission_deadline: iso(row.submission_deadline),
    task_count: Number(row.task_count ?? 0),
    file_count: Number(row.file_count ?? 0),
    invitation_status: row.recipient_status,
    ...(row.proposal_id ? { proposal_id: row.proposal_id, proposal_status: row.proposal_status } : {}),
    awarded_to_me: Boolean(row.proposal_id) && row.awarded_proposal_id === row.proposal_id,
    received_at: iso(row.received_at),
  };
}

/** #/components/schemas/OpenRequest — one listed RFP in "Open requests near you". */
export function openRequestBody(row, { build = null, distanceKm = null, myRequest = null } = {}) {
  return {
    rfp_id: row.id,
    title: row.title,
    issuer_level: row.level,
    ...(build ? { build: { name: build.name, ...(build.municipality_code ? { municipality_code: build.municipality_code } : {}) } } : {}),
    ...(distanceKm != null ? { distance_km: distanceKm } : {}),
    specialty_codes: row.specialty_codes ?? [],
    submission_deadline: iso(row.submission_deadline),
    task_count: Number(row.task_count ?? 0),
    ...(myRequest ? { my_request: bidRequestBody(myRequest) } : {}),
  };
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
