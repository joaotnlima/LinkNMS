// Directory application — the company side: profile editor, completeness,
// listing stats, stated portfolio (PRD-03 R-13, R-17, R-19, R-20), and the
// owner's consent to show a build's name (R-12). One function per operationId.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import {
  LISTABLE_KINDS, validateProfileWrite, completeness, ownerProfileBody, slugify,
} from '../domain/profile.mjs';
import { portfolioBody } from '../domain/public-profile.mjs';
import { UUID, ISO_DATE, requireOwnProfileOrg, requireActiveOrg, requireHuman, today } from './shared.mjs';

/** operationId: getMyProfile */
export async function getMyProfile({ viewer, store, orgId }) {
  requireOwnProfileOrg(viewer, orgId);
  const row = await store.getProfileByOrg(orgId);
  if (!row) throw new ProblemError('not_found', 'no directory profile yet — save one first');
  return { status: 200, body: ownerProfileBody(row) };
}

/**
 * operationId: putProfile — first save creates (201, slug minted, to-be/20
 * §5.2); later saves replace every stated field under If-Match.
 */
export async function putProfile({ viewer, store, orgId, body, ifMatch }) {
  requireOwnProfileOrg(viewer, orgId);
  if (!LISTABLE_KINDS.includes(viewer.orgKind)) {
    throw new ProblemError('forbidden', 'households are not listed in the directory', { reason: 'org_kind' });
  }
  const taxonomy = await store.listSpecialties();
  const { errors, value } = validateProfileWrite(body, { codes: new Set(taxonomy.map((s) => s.code)), today: today() });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const existing = await store.getProfileByOrg(orgId);
  const portfolioCount = existing ? await store.countPortfolio(orgId) : 0;
  const score = completeness(rowOf(value), portfolioCount).score;

  if (!existing) {
    const row = await store.insertProfile({
      orgId, kind: viewer.orgKind, slugBase: slugify(value.displayName), value, completeness: score,
    });
    return { status: 201, body: ownerProfileBody(row) };
  }
  const expected = parseIfMatch(ifMatch);
  if (expected !== Number(existing.version)) {
    throw new ProblemError('version_conflict', `the profile is at version ${existing.version}`);
  }
  const row = await store.updateProfile({ orgId, expectedVersion: expected, value, completeness: score });
  if (!row) throw new ProblemError('version_conflict', 'someone saved the profile first — reload');
  return { status: 200, body: ownerProfileBody(row) };
}

/** operationId: getCompleteness — R-19 checklist; never an ordering input (D-46). */
export async function getCompleteness({ viewer, store, orgId }) {
  requireOwnProfileOrg(viewer, orgId);
  const row = await store.getProfileByOrg(orgId);
  if (!row) throw new ProblemError('not_found', 'no directory profile yet — save one first');
  return { status: 200, body: completeness(row, await store.countPortfolio(orgId)) };
}

/** operationId: getListingStats — R-17, last 30 days. */
export async function getListingStats({ viewer, store, orgId }) {
  requireOwnProfileOrg(viewer, orgId);
  const stats = await store.listingStats({ orgId, days: 30 });
  return {
    status: 200,
    body: {
      days: 30,
      shown_in_searches: Number(stats.shown_in_searches ?? 0),
      profile_views: Number(stats.profile_views ?? 0),
      proposals_sent: Number(stats.proposals_sent ?? 0),
      proposals_awarded: Number(stats.proposals_awarded ?? 0),
    },
  };
}

/** operationId: listMyPortfolio — every entry, listed or not (the editor's view). */
export async function listMyPortfolio({ viewer, store, orgId, query = {} }) {
  requireOwnProfileOrg(viewer, orgId);
  const cursor = decodePortfolioCursor(query?.cursor);
  const n = Number(query?.limit ?? 50);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
  const { items, nextCursor } = await store.listPortfolioPage(orgId, { cursor, limit });
  return {
    status: 200,
    body: {
      items: items.map(portfolioBody),
      next_cursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString('base64url') : null,
    },
  };
}

function decodePortfolioCursor(raw) {
  if (!raw) return null;
  let c = null;
  try { c = JSON.parse(Buffer.from(String(raw), 'base64url').toString()); } catch { c = null; }
  const okEnd = c && (c.e === '-infinity' || /^\d{4}-\d{2}-\d{2}$/.test(c.e ?? ''));
  if (!okEnd || Number.isNaN(Date.parse(c.c ?? '')) || !UUID.test(c.id ?? '')) {
    throw new ProblemError('validation_failed', null, { errors: { cursor: 'not a cursor from this list' } });
  }
  return { e: c.e, c: c.c, id: c.id };
}

/** operationId: addPortfolioEntry — a stated (`declared`) entry; no photos yet. */
export async function addPortfolioEntry({ viewer, store, orgId, body, idempotencyKey }) {
  requireOwnProfileOrg(viewer, orgId);
  const profile = await store.getProfileByOrg(orgId);
  if (!profile) throw new ProblemError('not_found', 'save the profile first');
  const taxonomy = await store.listSpecialties();
  const codes = new Set(taxonomy.map((s) => s.code));
  const b = body ?? {};
  const errors = {};
  if (!UUID.test(b.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 160) errors.title = '1–160 characters';
  if (b.municipality_code != null && !/^\d{4}$/.test(b.municipality_code)) errors.municipality_code = 'a 4-digit INE code';
  if (b.typology != null && (typeof b.typology !== 'string' || b.typology.length > 60)) errors.typology = 'at most 60 characters';
  const specialties = b.specialties ?? [];
  if (!Array.isArray(specialties) || specialties.some((c) => !codes.has(c))) errors.specialties = 'taxonomy codes';
  for (const k of ['start_date', 'end_date']) {
    if (b[k] != null && !ISO_DATE.test(b[k])) errors[k] = 'an ISO date';
  }
  if (!errors.start_date && !errors.end_date && b.start_date && b.end_date && b.end_date < b.start_date) {
    errors.end_date = 'not before start_date';
  }
  if (b.photo_document_ids?.length) errors.photo_document_ids = 'photos are not accepted yet';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'addPortfolioEntry', body }, async () => {
    const entry = await store.insertPortfolioEntry({
      id: b.id, orgId, title,
      municipalityCode: b.municipality_code ?? null,
      typology: b.typology?.trim() || null,
      specialties: [...new Set(specialties)],
      startDate: b.start_date ?? null,
      endDate: b.end_date ?? null,
    });
    await refreshCompleteness(store, orgId);
    return { status: 201, body: portfolioBody(entry) };
  });
}

/** operationId: deletePortfolioEntry — stated entries only. */
export async function deletePortfolioEntry({ viewer, store, orgId, entryId }) {
  requireOwnProfileOrg(viewer, orgId);
  if (!UUID.test(entryId ?? '')) throw new ProblemError('not_found');
  const entry = await store.getPortfolioEntry(entryId);
  if (!entry || entry.org_id !== orgId) throw new ProblemError('not_found');
  if (entry.source !== 'declared') {
    throw new ProblemError('invalid_transition', 'an entry from a LinkNMS build belongs to the record');
  }
  await store.deletePortfolioEntry(entryId);
  await refreshCompleteness(store, orgId);
  return { status: 204, body: null };
}

/** operationId: getPortfolioConsent — project.owner (through the build port). */
export async function getPortfolioConsent({ viewer, store, builds, projectId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await builds.ownedBuild({ viewer, projectId });
  const row = await store.getConsent(projectId);
  return { status: 200, body: consentBody(projectId, row) };
}

/**
 * operationId: putPortfolioConsent — the owner allows or withdraws showing
 * the build's name on its companies' profiles (R-12). The name is snapshot
 * from the project module's build port at consent time.
 */
export async function putPortfolioConsent({ viewer, store, builds, projectId, body }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'consenting to publish a build');
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  if (!viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const build = await builds.ownedBuild({ viewer, projectId });
  const errors = {};
  if (typeof body?.show_on_profiles !== 'boolean') errors.show_on_profiles = 'true or false';
  if (body?.note != null && (typeof body.note !== 'string' || body.note.length > 500)) errors.note = 'at most 500 characters';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (!viewer.personId) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  const row = await store.putConsent({
    projectId,
    ownerOrgId: viewer.orgId,
    showOnProfiles: body.show_on_profiles,
    buildName: body.show_on_profiles ? build.name : null,
    note: body.note?.trim() || null,
    personId: viewer.personId,
  });
  return { status: 200, body: consentBody(projectId, row) };
}

function consentBody(projectId, row) {
  const shown = Boolean(row?.show_on_profiles);
  return {
    project_id: projectId,
    show_on_profiles: shown,
    ...(shown && row.build_name ? { name: row.build_name } : {}),
    ...(row?.decided_at ? { decided_at: new Date(row.decided_at).toISOString() } : {}),
  };
}

async function refreshCompleteness(store, orgId) {
  const row = await store.getProfileByOrg(orgId);
  if (!row) return;
  await store.setCompleteness({ orgId, completeness: completeness(row, await store.countPortfolio(orgId)).score });
}

/** The validated value in row shape, for the completeness checklist. */
function rowOf(v) {
  return {
    specialties: v.specialties,
    base_lat: v.base.lat,
    service_radius_km: v.serviceRadiusKm,
    description: v.description,
    declared_impic_number: v.declared.impicNumber,
    declared_insurance: v.declared.insurance,
    available_from: v.availableFrom,
  };
}

function parseIfMatch(raw) {
  const n = Number(String(raw ?? '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) {
    throw new ProblemError('version_conflict', 'the profile exists — send If-Match with its version');
  }
  return n;
}
