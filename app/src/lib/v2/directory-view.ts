// Pure v2-wire → view transforms for the company directory (PRD-03). The I/O is
// in `./directory.ts`. Nothing here ranks, filters or counts: the order (D-46),
// the facet counts and every "on the record" number come from the API as-is.
// This file only words them, labels each claim with its proof level, and builds
// the URLs the search form and facets link to.

export type TeamSizeBand = '1' | '2-5' | '6-20' | '21-50' | '50+';

export interface V2Specialty {
  code: string;
  name_pt: string;
  name_en: string;
  parent_code: string | null;
  position: number;
  impic_ref: string | null;
  impic_ref_verified: boolean;
}

export interface V2OnRecord {
  ranked: boolean;
  verified_clients: number;
  builds: number;
  tasks_finished: number;
  tasks_on_time: number;
  change_orders_raised: number;
  change_orders_approved: number;
}

export interface V2Stated {
  licence_number_given: boolean;
  impic_class?: string;
  insurance_given: boolean;
  available_from?: string;
  portfolio_count: number;
}

export interface V2DirectoryCard {
  org_id: string;
  slug: string;
  display_name: string;
  kind?: string;
  claimed: boolean;
  base_municipality_code?: string;
  distance_km?: number;
  service_radius_km?: number;
  team_size_band?: TeamSizeBand;
  specialties: string[];
  specialty_match?: 'exact' | 'related';
  record: V2OnRecord;
  stated?: V2Stated;
}

export interface V2Facets {
  work_types: { code: string; count: number }[];
  proof: { on_record: number; licence: number; portfolio: number };
  size: { band: TeamSizeBand; count: number }[];
  claimed: number;
}

export interface V2SearchNear {
  source: 'project' | 'point' | 'municipality' | 'district';
  lat?: number;
  lng?: number;
  radius_km?: number;
  code?: string;
  label?: string;
}

export interface V2DirectorySearch {
  items: V2DirectoryCard[];
  next_cursor: string | null;
  total: number;
  ranked_total: number;
  near: V2SearchNear | null;
  facets: V2Facets;
}

export interface V2PortfolioEntry {
  id: string;
  source: 'platform' | 'declared';
  title: string;
  municipality_code?: string;
  typology?: string;
  specialties: string[];
  start_date?: string;
  end_date?: string;
}

export interface V2DirectoryBuild {
  state: 'in_progress' | 'closed' | 'terminated';
  signed_on: string;
  finished_on?: string;
  name?: string;
  tasks_finished: number;
  tasks_on_time: number;
}

export interface V2DirectoryProfile extends V2DirectoryCard {
  description?: string;
  tags?: string[];
  service_areas?: string[];
  founded_year?: number;
  on_linknms_since: string;
  builds: V2DirectoryBuild[];
  portfolio: V2PortfolioEntry[];
  claim: { available: boolean };
}

export interface V2OrganizationProfile {
  org_id: string;
  slug: string;
  display_name: string;
  kind?: string;
  claimed: boolean;
  description?: string;
  specialties: string[];
  tags: string[];
  service_areas: string[];
  base: { municipality_code?: string; lat?: number; lng?: number };
  service_radius_km?: number;
  team_size_band?: TeamSizeBand;
  founded_year?: number;
  available_from?: string;
  declared: { nif?: string; impic_number?: string; impic_class?: string; insurance?: string };
  listed: boolean;
  completeness: number;
  created_at: string;
  version: number;
}

export interface V2Completeness {
  score: number;
  items: { item: string; done: boolean; points: number }[];
  missing: { item: string; points: number }[];
}

export interface V2ListingStats {
  days: number;
  shown_in_searches: number;
  profile_views: number;
  proposals_sent: number;
  proposals_awarded: number;
}

export const RADII = [25, 50, 100] as const;
export const TEAM_SIZE_LABEL: Record<TeamSizeBand, string> = {
  '1': '1 person', '2-5': '2–5 people', '6-20': '6–20 people', '21-50': '21–50 people', '50+': 'More than 50',
};

/** The English name of a taxonomy code (the code itself when unknown). */
export function specialtyLabel(code: string, taxonomy: readonly V2Specialty[]): string {
  const s = taxonomy.find((x) => x.code === code);
  return s ? s.name_en : code;
}

/** Parents with their children, in taxonomy order — for grouped selects. */
export function specialtyGroups(taxonomy: readonly V2Specialty[]): { parent: V2Specialty; children: V2Specialty[] }[] {
  return taxonomy
    .filter((s) => !s.parent_code)
    .map((parent) => ({ parent, children: taxonomy.filter((c) => c.parent_code === parent.code) }));
}

export type ProofLevel = 'on_record' | 'stated';
export interface ProofLine { level: ProofLevel; label: string; text: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The labelled proof lines of a result card (R-6, §4.4 as decided by D-46):
 * "On the record" from the read model, "Stated" from the company. No "Checked"
 * level exists. Every line carries exactly one label.
 */
export function cardProofLines(card: V2DirectoryCard): ProofLine[] {
  const r = card.record;
  const lines: ProofLine[] = [];
  if (r.ranked) {
    const tasks = r.tasks_finished
      ? ` · ${r.tasks_on_time} of ${r.tasks_finished} tasks finished on the planned date`
      : ' · no tasks finished yet';
    lines.push({
      level: 'on_record', label: 'On the record',
      text: `${plural(r.verified_clients, 'verified client', 'verified clients')} · ${plural(r.builds, 'build', 'builds')} on LinkNMS${tasks}`,
    });
  } else {
    lines.push({ level: 'on_record', label: 'On the record', text: 'No verified clients yet' });
  }
  if (!card.claimed) {
    lines.push({ level: 'stated', label: 'Stated', text: 'Nothing yet — the company has not claimed this profile' });
    return lines;
  }
  const s = card.stated;
  if (s?.licence_number_given) {
    lines.push({ level: 'stated', label: 'Stated', text: `Alvará IMPIC number given${s.impic_class ? `, class ${s.impic_class}` : ''} · not checked` });
  }
  if (s?.available_from) lines.push({ level: 'stated', label: 'Stated', text: `Can start from ${formatDay(s.available_from)}` });
  return lines;
}

/** "Mem Martins · 6 km · serves up to 40 km · 6–20 people" */
export function whereLine(card: V2DirectoryCard): string {
  const bits: string[] = [];
  if (card.base_municipality_code) bits.push(`Municipality ${card.base_municipality_code}`);
  if (card.distance_km != null) bits.push(`${formatKm(card.distance_km)} away`);
  if (card.service_radius_km != null) bits.push(`serves up to ${card.service_radius_km} km`);
  if (card.team_size_band) bits.push(TEAM_SIZE_LABEL[card.team_size_band]);
  if (!card.claimed) bits.push('unclaimed profile');
  return bits.join(' · ');
}

export function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(km)} km`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2027-02-01" → "1 Feb 2027" (no timezone shift: the date is a calendar day). */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function buildStateLabel(state: V2DirectoryBuild['state']): { text: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (state === 'closed') return { text: 'Closed', tone: 'ok' };
  if (state === 'in_progress') return { text: 'In progress', tone: 'warn' };
  return { text: 'Terminated', tone: 'neutral' };
}

/** The search form state as read from /companies?… (view state only). */
export interface SearchParams {
  specialty?: string;
  near_project?: string;
  municipality?: string;
  lat?: string;
  lng?: string;
  radius_km?: string;
  can_start_by?: string;
  q?: string;
  work_type?: string;
  proof?: string;
  size?: string;
  claimed?: string;
  cursor?: string;
}

const KEYS: (keyof SearchParams)[] = [
  'specialty', 'near_project', 'municipality', 'lat', 'lng', 'radius_km', 'can_start_by', 'q',
  'work_type', 'proof', 'size', 'claimed', 'cursor',
];

/** Only the known, non-empty params — what is passed on to the API. */
export function cleanParams(raw: Record<string, string | string[] | undefined>): SearchParams {
  const out: SearchParams = {};
  for (const k of KEYS) {
    const v = raw[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s != null && String(s).trim() !== '') out[k] = String(s).trim();
  }
  return out;
}

/** /companies?… with one comma-list facet value toggled (and the cursor reset). */
export function toggleFacetHref(params: SearchParams, key: 'work_type' | 'proof' | 'size', value: string, base = '/companies'): string {
  const current = (params[key] ?? '').split(',').filter(Boolean);
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return hrefWith({ ...params, [key]: next.join(',') || undefined, cursor: undefined }, base);
}

export function facetOn(params: SearchParams, key: 'work_type' | 'proof' | 'size', value: string): boolean {
  return (params[key] ?? '').split(',').includes(value);
}

export function hrefWith(params: SearchParams, base = '/companies'): string {
  const usp = new URLSearchParams();
  for (const k of KEYS) {
    const v = params[k];
    if (v != null && v !== '') usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** The result heading: "12 companies near Casa da Encosta · 4 with verified clients". */
export function resultHeading(res: Pick<V2DirectorySearch, 'total' | 'ranked_total' | 'near'>, specialty?: string): string {
  const what = specialty ? `${specialty.toLowerCase()} ` : '';
  const where = res.near?.label
    ? ` near ${res.near.label}`
    : res.near?.source === 'point' ? ' near the chosen point'
      : res.near?.code ? ` in ${res.near.source} ${res.near.code}` : '';
  return `${plural(res.total, `${what}company`, `${what}companies`)}${where} · ${res.ranked_total} with verified clients`;
}

export const COMPLETENESS_LABEL: Record<string, string> = {
  specialties: 'Specialties — the work types you do',
  base: 'Base location and service radius',
  description: 'About the company',
  licence: 'Alvará IMPIC number (stated)',
  insurance: 'Insurance (stated)',
  portfolio: 'Portfolio — at least one past job',
  availability: 'Availability — when you can start new work',
};

/** Mask nothing, invent nothing: a missing count is 0 from the API, shown as is. */
export function listingStatTiles(stats: V2ListingStats | null): { value: string; label: string }[] {
  if (!stats) return [];
  return [
    { value: String(stats.shown_in_searches), label: `times shown in searches · last ${stats.days} days` },
    { value: String(stats.profile_views), label: 'profile views' },
    { value: String(stats.proposals_sent), label: 'proposals sent' },
    { value: String(stats.proposals_awarded), label: 'proposals awarded' },
  ];
}

/** The chips to highlight on a card: the searched code, its parent, its children. */
export function familyCodes(code: string | undefined, taxonomy: readonly V2Specialty[]): string[] {
  if (!code) return [];
  const node = taxonomy.find((s) => s.code === code);
  if (!node) return [];
  return [code, ...(node.parent_code ? [node.parent_code] : []), ...taxonomy.filter((s) => s.parent_code === code).map((s) => s.code)];
}

/**
 * The editor form → `OrganizationProfileWrite` (PRD-03 R-20). Shapes only —
 * blanks become absent/null, numbers are parsed, lists split; every rule
 * (taxonomy codes, ranges, both-or-neither) is the API's, which answers 422.
 */
export function profileWriteFromForm(
  get: (k: string) => string,
  getAll: (k: string) => string[],
): Record<string, unknown> {
  const text = (k: string) => get(k).trim();
  const num = (k: string) => (text(k) === '' ? undefined : Number(text(k).replace(',', '.')));
  const int = (k: string) => (text(k) === '' ? undefined : Number.parseInt(text(k), 10));
  const optional = (k: string) => text(k) || undefined;
  const lat = num('base_lat');
  const lng = num('base_lng');
  return {
    display_name: text('display_name'),
    description: optional('description'),
    specialties: getAll('specialties').filter(Boolean),
    tags: text('tags').split(',').map((t) => t.trim()).filter(Boolean),
    service_areas: text('service_areas').split(/[\s,]+/).filter(Boolean),
    base: {
      ...(optional('base_municipality_code') ? { municipality_code: text('base_municipality_code') } : {}),
      ...(lat !== undefined || lng !== undefined ? { lat, lng } : {}),
    },
    service_radius_km: int('service_radius_km'),
    team_size_band: optional('team_size_band'),
    founded_year: int('founded_year'),
    available_from: optional('available_from') ?? null,
    declared: {
      nif: optional('declared_nif'),
      impic_number: optional('declared_impic_number'),
      impic_class: optional('declared_impic_class'),
      insurance: optional('declared_insurance'),
    },
    listed: get('listed') === 'on',
  };
}
