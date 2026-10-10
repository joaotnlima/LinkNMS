// Company directory data layer on `/api/v2` (PRD-03). I/O only — the pure
// arranging is `./directory-view.ts`. The public reads go out with
// `allowAnonymous` (the operations are `security: []`): a signed-out visitor
// browses the directory; a signed-in one is still resolved (near_project, and
// a company's own views are not counted). Company-side writes rethrow the
// V2Error so the action can show the server's reason.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2, V2Error } from './client';
import type {
  SearchParams, V2Completeness, V2DirectoryProfile, V2DirectorySearch, V2ListingStats,
  V2OrganizationProfile, V2PortfolioEntry, V2Specialty,
} from './directory-view';

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

// ── public ───────────────────────────────────────────────────────────────────

export async function listSpecialties(): Promise<V2Specialty[]> {
  const page = await orNull(v2<{ items: V2Specialty[] }>({
    method: 'GET', path: '/specialties', query: { limit: 200 }, allowAnonymous: true,
  }));
  return page?.items ?? [];
}

/** Throws V2Error (422 field errors, 404 for a build the viewer is not on). */
export function searchCompanies(params: SearchParams, limit = 20): Promise<V2DirectorySearch> {
  return v2<V2DirectorySearch>({
    method: 'GET', path: '/directory/organizations', query: { ...params, limit }, allowAnonymous: true,
  });
}

export function getCompanyBySlug(slug: string): Promise<V2DirectoryProfile | null> {
  return orNull(v2<V2DirectoryProfile>({
    method: 'GET', path: `/directory/organizations/by-slug/${encodeURIComponent(slug)}`, allowAnonymous: true,
  }));
}

// ── company side ─────────────────────────────────────────────────────────────

export function getMyProfile(orgId: string): Promise<V2OrganizationProfile | null> {
  return orNull(v2<V2OrganizationProfile>({ method: 'GET', path: `/organizations/${encodeURIComponent(orgId)}/profile` }));
}

export function putMyProfile(orgId: string, body: Record<string, unknown>, version: number | null): Promise<V2OrganizationProfile> {
  return v2<V2OrganizationProfile>({
    method: 'PUT', path: `/organizations/${encodeURIComponent(orgId)}/profile`, body,
    ...(version != null ? { ifMatch: version } : {}),
  });
}

export function getCompleteness(orgId: string): Promise<V2Completeness | null> {
  return orNull(v2<V2Completeness>({ method: 'GET', path: `/organizations/${encodeURIComponent(orgId)}/profile/completeness` }));
}

export function getListingStats(orgId: string): Promise<V2ListingStats | null> {
  return orNull(v2<V2ListingStats>({ method: 'GET', path: `/organizations/${encodeURIComponent(orgId)}/listing-stats` }));
}

export async function listMyPortfolio(orgId: string): Promise<V2PortfolioEntry[]> {
  const page = await orNull(v2<{ items: V2PortfolioEntry[] }>({ method: 'GET', path: `/organizations/${encodeURIComponent(orgId)}/portfolio` }));
  return page?.items ?? [];
}

export function addPortfolioEntry(orgId: string, body: Omit<V2PortfolioEntry, 'id' | 'source'>): Promise<V2PortfolioEntry> {
  const id = randomUUID();
  return v2<V2PortfolioEntry>({
    method: 'POST', path: `/organizations/${encodeURIComponent(orgId)}/portfolio`, body: { id, ...body }, idempotencyKey: id,
  });
}

export async function deletePortfolioEntry(orgId: string, entryId: string): Promise<void> {
  await v2({ method: 'DELETE', path: `/organizations/${encodeURIComponent(orgId)}/portfolio/${encodeURIComponent(entryId)}` });
}

export function claimProfile(orgId: string): Promise<{ sent_to: string; expires_at: string }> {
  return v2({ method: 'POST', path: `/directory/organizations/${encodeURIComponent(orgId)}:claim` });
}

export function acceptProfileClaim(token: string): Promise<V2OrganizationProfile> {
  return v2({ method: 'POST', path: `/directory/claims/${encodeURIComponent(token)}:accept` });
}

// ── the owner's consent (R-12) ───────────────────────────────────────────────

export interface V2PortfolioConsent { project_id: string; show_on_profiles: boolean; name?: string; decided_at?: string }

export function getPortfolioConsent(projectId: string): Promise<V2PortfolioConsent | null> {
  return orNull(v2<V2PortfolioConsent>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}/portfolio-consent` }));
}

export function putPortfolioConsent(projectId: string, show: boolean): Promise<V2PortfolioConsent> {
  return v2<V2PortfolioConsent>({
    method: 'PUT', path: `/projects/${encodeURIComponent(projectId)}/portfolio-consent`, body: { show_on_profiles: show },
  });
}
