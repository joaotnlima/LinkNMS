// Directory application — the public reads: taxonomy, search, profile
// (PRD-03 R-1, R-4..R-16). One function per operationId.
//
// The store answers candidate rows (profile + distance + on-record counts
// from the directory's OWN read model); ranking, facets and paging are the
// domain's (domain/ranking.mjs, D-46). The build's point for `near_project`
// comes from the project module's build port, which applies getProject's
// participant + staffing rule — the directory never reads project tables.
import { ProblemError } from '../../../platform/errors.mjs';
import {
  specialtyFamily, cardBody, sortCards, applyFacetFilters, facetCounts, pageAfter, decodeCursor,
} from '../domain/ranking.mjs';
import { publicProfileBody } from '../domain/public-profile.mjs';
import { TEAM_SIZE_BANDS } from '../domain/profile.mjs';
import { UUID, ISO_DATE, requireSession, listParam } from './shared.mjs';

const RADII = [25, 50, 100];
const PROOFS = ['on_record', 'licence', 'portfolio'];
const KINDS = ['contractor', 'consultant', 'supplier'];
/** The ranked set is computed in memory over at most this many candidates. */
export const CANDIDATE_CAP = 500;

/** operationId: listSpecialties — public taxonomy, parents before children. */
export async function listSpecialties({ store, query }) {
  const all = await store.listSpecialties();
  const limit = clamp(query?.limit, 200, 200);
  const after = query?.cursor ? Number(query.cursor) : 0;
  if (!Number.isInteger(after) || after < 0) {
    throw new ProblemError('validation_failed', null, { errors: { cursor: 'not a cursor from this list' } });
  }
  const rest = all.filter((s) => Number(s.position) > after);
  const items = rest.slice(0, limit);
  return {
    status: 200,
    body: {
      items: items.map(specialtyBody),
      next_cursor: rest.length > limit ? String(items[items.length - 1].position) : null,
    },
  };
}

/** operationId: searchOrganizations — public; ranking per D-46. */
export async function searchOrganizations({ viewer, store, builds, query = {} }) {
  const taxonomy = await store.listSpecialties();
  const q = parseSearch(query, taxonomy);

  let near = null;
  if (q.nearProject) {
    requireSession(viewer);
    const build = await builds.locationFor({ viewer, projectId: q.nearProject });
    if (build?.lat != null) {
      near = { source: 'project', lat: build.lat, lng: build.lng, radius_km: q.radiusKm, label: build.name };
    } else {
      // A build without a point falls back to its municipality (R-3 "at minimum").
      near = { source: 'municipality', code: build.municipality_code, label: build.name };
    }
  } else if (q.lat != null) {
    near = { source: 'point', lat: q.lat, lng: q.lng, radius_km: q.radiusKm };
  } else if (q.municipality) {
    near = { source: 'municipality', code: q.municipality };
  } else if (q.district) {
    near = { source: 'district', code: q.district };
  }

  const family = specialtyFamily(q.specialty, taxonomy);
  const rows = await store.searchCandidates({
    specialtyCodes: family?.codes ?? null,
    point: near?.lat != null ? { lat: near.lat, lng: near.lng, radiusKm: near.radius_km } : null,
    municipality: near?.source === 'municipality' ? near.code : null,
    district: near?.source === 'district' ? near.code : null,
    kind: q.kind,
    canStartBy: q.canStartBy,
    text: q.text,
    limit: CANDIDATE_CAP,
  });

  const cards = rows.map((r) => cardBody(r, family));
  const facets = facetCounts(cards, taxonomy, family);
  const filtered = applyFacetFilters(cards, q.facets);
  const sorted = sortCards(filtered);
  const page = pageAfter(sorted, q.cursor, q.limit);

  // R-17: count the impressions of the page actually served — never the
  // viewer's own organisation. Analytics must not fail the read.
  const shown = page.items.map((c) => c.org_id).filter((id) => id !== viewer?.orgId);
  if (shown.length) await store.recordStat({ orgIds: shown, kind: 'search_impression' }).catch(() => {});

  return {
    status: 200,
    body: {
      items: page.items,
      next_cursor: page.nextCursor,
      total: filtered.length,
      ranked_total: filtered.filter((c) => c.record.ranked).length,
      near,
      facets,
    },
  };
}

/** operationId: getDirectoryProfileBySlug — public profile (/companies/{slug}). */
export async function getDirectoryProfileBySlug({ viewer, store, slug }) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug ?? '')) throw new ProblemError('not_found');
  return profileResponse({ viewer, store, row: await store.getPublicProfile({ slug }) });
}

/** operationId: getDirectoryOrganization — the same profile by id. */
export async function getDirectoryOrganization({ viewer, store, orgId }) {
  if (!UUID.test(orgId ?? '')) throw new ProblemError('not_found');
  return profileResponse({ viewer, store, row: await store.getPublicProfile({ orgId }) });
}

async function profileResponse({ viewer, store, row }) {
  // Unlisted profiles do not exist publicly (404, not 403).
  if (!row || !row.listed) throw new ProblemError('not_found');
  const [builds, portfolio] = await Promise.all([
    store.buildsOnRecord(row.org_id),
    store.listPortfolio(row.org_id),
  ]);
  if (viewer?.orgId !== row.org_id) {
    await store.recordStat({ orgIds: [row.org_id], kind: 'profile_view' }).catch(() => {});
  }
  return { status: 200, body: publicProfileBody(row, { builds, portfolio }) };
}

export function specialtyBody(s) {
  return {
    code: s.code,
    name_pt: s.name_pt,
    name_en: s.name_en,
    parent_code: s.parent_code ?? null,
    position: Number(s.position),
    impic_ref: s.impic_ref ?? null,
    // The IMPIC mapping is reference metadata, written from the 2004
    // classification and not checked against the current official list.
    impic_ref_verified: false,
  };
}

/** Validate the search query (422 with field errors; unknown params ignored). */
export function parseSearch(query, taxonomy) {
  const errors = {};
  const out = { facets: {} };

  out.specialty = query.specialty || null;
  if (out.specialty && !taxonomy.some((s) => s.code === out.specialty)) errors.specialty = 'not a taxonomy code';

  out.text = query.q ? String(query.q).trim().slice(0, 80) || null : null;

  out.nearProject = query.near_project || null;
  if (out.nearProject && !UUID.test(out.nearProject)) errors.near_project = 'a project id';

  out.lat = null;
  out.lng = null;
  const hasLat = query.lat != null && query.lat !== '';
  const hasLng = query.lng != null && query.lng !== '';
  if (hasLat !== hasLng) errors.lat = 'lat and lng go together';
  else if (hasLat) {
    const la = Number(query.lat);
    const lo = Number(query.lng);
    if (!Number.isFinite(la) || la < -90 || la > 90) errors.lat = 'between -90 and 90';
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) errors.lng = 'between -180 and 180';
    out.lat = la;
    out.lng = lo;
  }

  out.radiusKm = query.radius_km == null || query.radius_km === '' ? 50 : Number(query.radius_km);
  if (!RADII.includes(out.radiusKm)) errors.radius_km = '25, 50 or 100';

  out.municipality = query.municipality || null;
  if (out.municipality && !/^\d{4}$/.test(out.municipality)) errors.municipality = 'a 4-digit INE code';
  out.district = query.district || null;
  if (out.district && !/^\d{2}$/.test(out.district)) errors.district = 'a 2-digit INE code';

  out.kind = query.kind || null;
  if (out.kind && !KINDS.includes(out.kind)) errors.kind = KINDS.join(', ');

  out.canStartBy = query.can_start_by || null;
  if (out.canStartBy && (!ISO_DATE.test(out.canStartBy) || Number.isNaN(Date.parse(out.canStartBy)))) {
    errors.can_start_by = 'an ISO date';
  }

  out.facets.workTypes = listParam(query.work_type);
  if (out.facets.workTypes.some((c) => !taxonomy.some((s) => s.code === c))) errors.work_type = 'taxonomy codes';
  out.facets.proof = listParam(query.proof);
  if (out.facets.proof.some((p) => !PROOFS.includes(p))) errors.proof = PROOFS.join(', ');
  out.facets.sizes = listParam(query.size);
  if (out.facets.sizes.some((s) => !TEAM_SIZE_BANDS.includes(s))) errors.size = TEAM_SIZE_BANDS.join(', ');
  out.facets.claimed = null;
  if (query.claimed != null && query.claimed !== '') {
    if (!['true', 'false', true, false].includes(query.claimed)) errors.claimed = 'true or false';
    else out.facets.claimed = String(query.claimed) === 'true';
  }

  out.cursor = query.cursor || null;
  if (out.cursor && !decodeCursor(out.cursor)) errors.cursor = 'not a cursor from this search';
  out.limit = clamp(query.limit, 20, 50);

  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  return out;
}

function clamp(raw, dflt, max) {
  const n = Number(raw ?? dflt);
  if (!Number.isInteger(n) || n < 1) return dflt;
  return Math.min(n, max);
}
