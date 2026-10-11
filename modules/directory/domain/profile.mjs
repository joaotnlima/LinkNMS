// Directory domain — the company profile: slug policy, write validation,
// completeness, and the owner's wire projection. Pure, no I/O (doc 02 layout).
//
// Proof levels (PRD-03 §4.4 as decided by D-46): everything a company writes
// here is STATED — credentials included (D-17 amended: no "Checked" level).
// Completeness is shown to the company with what raises it and NEVER feeds
// the order of search results (D-46) — see domain/ranking.mjs.

export const TEAM_SIZE_BANDS = Object.freeze(['1', '2-5', '6-20', '21-50', '50+']);
export const LISTABLE_KINDS = Object.freeze(['contractor', 'consultant', 'supplier']);

/** Words a slug may not be alone: they are path segments next to /companies/{slug}. */
export const RESERVED_SLUGS = Object.freeze(['claim', 'new', 'search', 'by-slug']);
const SLUG_MAX = 60;

/**
 * to-be/20 §5.2 default (PRD-03): lowercase, diacritics stripped, every run of
 * non-alphanumerics → '-', trimmed, ≤ 60 chars. An empty result falls back
 * to 'company'. Collisions are resolved by the store with `slugCandidate`.
 */
export function slugify(name) {
  const base = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return base || 'company';
}

/** The n-th candidate for a base slug: base, base-2, base-3 … (reserved words skip to -2). */
export function slugCandidate(base, n) {
  if (n <= 1 && !RESERVED_SLUGS.includes(base)) return base;
  return `${base}-${Math.max(n, 2)}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const AREA = /^\d{2}(\d{2})?$/;
const MUNICIPALITY = /^\d{4}$/;

/**
 * Validate an OrganizationProfileWrite body against the taxonomy.
 * @param {object} body
 * @param {{ codes: Set<string>, today: string }} ctx
 * @returns {{ errors: Record<string,string>, value: object }}
 */
export function validateProfileWrite(body, { codes, today }) {
  const errors = {};
  const b = body ?? {};
  const value = {};

  const name = typeof b.display_name === 'string' ? b.display_name.trim() : '';
  if (!name) errors.display_name = 'required';
  else if (name.length > 120) errors.display_name = 'at most 120 characters';
  value.displayName = name;

  value.description = optionalText(b.description, 2000, 'description', errors);

  value.specialties = [];
  if (b.specialties != null) {
    if (!Array.isArray(b.specialties) || b.specialties.length > 30) errors.specialties = 'a list of at most 30 taxonomy codes';
    else {
      const unknown = b.specialties.filter((c) => !codes.has(c));
      if (unknown.length) errors.specialties = `unknown specialty: ${unknown.slice(0, 3).join(', ')}`;
      value.specialties = [...new Set(b.specialties)];
    }
  }

  value.tags = [];
  if (b.tags != null) {
    if (!Array.isArray(b.tags) || b.tags.length > 20
      || b.tags.some((t) => typeof t !== 'string' || !t.trim() || t.trim().length > 40)) {
      errors.tags = 'at most 20 tags of 1–40 characters';
    } else value.tags = [...new Set(b.tags.map((t) => t.trim()))];
  }

  value.serviceAreas = [];
  if (b.service_areas != null) {
    if (!Array.isArray(b.service_areas) || b.service_areas.length > 50 || b.service_areas.some((a) => !AREA.test(a ?? ''))) {
      errors.service_areas = 'at most 50 INE district (2 digits) or municipality (4 digits) codes';
    } else value.serviceAreas = [...new Set(b.service_areas)];
  }

  value.base = { municipalityCode: null, lat: null, lng: null };
  if (b.base != null) {
    if (typeof b.base !== 'object') errors.base = 'an object';
    else {
      const { municipality_code: m, lat, lng } = b.base;
      if (m != null && m !== '') {
        if (!MUNICIPALITY.test(m)) errors['base.municipality_code'] = 'a 4-digit INE municipality code';
        else value.base.municipalityCode = m;
      }
      const hasLat = lat != null && lat !== '';
      const hasLng = lng != null && lng !== '';
      if (hasLat !== hasLng) errors.base = 'lat and lng go together';
      else if (hasLat) {
        const la = Number(lat);
        const lo = Number(lng);
        if (!Number.isFinite(la) || la < -90 || la > 90) errors['base.lat'] = 'between -90 and 90';
        if (!Number.isFinite(lo) || lo < -180 || lo > 180) errors['base.lng'] = 'between -180 and 180';
        value.base.lat = round5(la);
        value.base.lng = round5(lo);
      }
    }
  }

  value.serviceRadiusKm = null;
  if (b.service_radius_km != null) {
    if (!Number.isInteger(b.service_radius_km) || b.service_radius_km < 1 || b.service_radius_km > 300) {
      errors.service_radius_km = 'an integer between 1 and 300';
    } else value.serviceRadiusKm = b.service_radius_km;
  }

  value.teamSizeBand = null;
  if (b.team_size_band != null) {
    if (!TEAM_SIZE_BANDS.includes(b.team_size_band)) errors.team_size_band = TEAM_SIZE_BANDS.join(', ');
    else value.teamSizeBand = b.team_size_band;
  }

  value.foundedYear = null;
  if (b.founded_year != null) {
    const year = Number(today.slice(0, 4));
    if (!Number.isInteger(b.founded_year) || b.founded_year < 1800 || b.founded_year > year) {
      errors.founded_year = `a year between 1800 and ${year}`;
    } else value.foundedYear = b.founded_year;
  }

  value.availableFrom = null;
  if (b.available_from != null) {
    if (!ISO_DATE.test(b.available_from) || Number.isNaN(Date.parse(b.available_from))) errors.available_from = 'an ISO date';
    else value.availableFrom = b.available_from;
  }

  const d = b.declared ?? {};
  if (typeof d !== 'object') errors.declared = 'an object';
  value.declared = {
    nif: optionalText(d.nif, 20, 'declared.nif', errors),
    impicNumber: optionalText(d.impic_number, 40, 'declared.impic_number', errors),
    impicClass: optionalText(d.impic_class, 20, 'declared.impic_class', errors),
    insurance: optionalText(d.insurance, 200, 'declared.insurance', errors),
  };

  if (b.listed != null && typeof b.listed !== 'boolean') errors.listed = 'true or false';
  value.listed = b.listed === true;

  return { errors, value };
}

/**
 * R-19 checklist. Points add to 100. Completeness is the company's to-do
 * list — never an input to the order of results (D-46).
 * @param {object} row  organization_profile row
 * @param {number} portfolioCount
 */
export function completeness(row, portfolioCount = 0) {
  const items = [
    { item: 'specialties', points: 20, done: (row.specialties ?? []).length > 0 },
    { item: 'base', points: 20, done: row.base_lat != null && row.service_radius_km != null },
    { item: 'description', points: 10, done: Boolean(row.description?.trim()) },
    { item: 'licence', points: 15, done: Boolean(row.declared_impic_number?.trim()) },
    { item: 'insurance', points: 10, done: Boolean(row.declared_insurance?.trim()) },
    { item: 'portfolio', points: 15, done: portfolioCount > 0 },
    { item: 'availability', points: 10, done: row.available_from != null },
  ];
  const score = items.reduce((n, i) => n + (i.done ? i.points : 0), 0);
  return {
    score,
    items,
    missing: items.filter((i) => !i.done).map(({ item, points }) => ({ item, points })),
  };
}

/** OrganizationProfile — the owning organisation's own view (every stated field). */
export function ownerProfileBody(row) {
  return {
    org_id: row.org_id,
    slug: row.slug,
    display_name: row.display_name,
    ...(row.kind ? { kind: row.kind } : {}),
    claimed: row.claimed,
    ...(row.description ? { description: row.description } : {}),
    specialties: row.specialties ?? [],
    tags: row.tags ?? [],
    service_areas: row.service_areas ?? [],
    base: baseBody(row),
    ...(row.service_radius_km != null ? { service_radius_km: Number(row.service_radius_km) } : {}),
    ...(row.team_size_band ? { team_size_band: row.team_size_band } : {}),
    ...(row.founded_year != null ? { founded_year: Number(row.founded_year) } : {}),
    ...(row.available_from ? { available_from: isoDate(row.available_from) } : {}),
    declared: {
      ...(row.declared_nif ? { nif: row.declared_nif } : {}),
      ...(row.declared_impic_number ? { impic_number: row.declared_impic_number } : {}),
      ...(row.declared_impic_class ? { impic_class: row.declared_impic_class } : {}),
      ...(row.declared_insurance ? { insurance: row.declared_insurance } : {}),
    },
    listed: row.listed,
    completeness: Number(row.completeness ?? 0),
    created_at: new Date(row.created_at).toISOString(),
    version: Number(row.version),
  };
}

export function baseBody(row) {
  return {
    ...(row.base_municipality_code ? { municipality_code: row.base_municipality_code } : {}),
    ...(row.base_lat != null ? { lat: Number(row.base_lat), lng: Number(row.base_lng) } : {}),
  };
}

/** "joao@douro.pt" → "j***@d***.pt" — the claim answer never reveals the address. */
export function maskEmail(email) {
  const [local, domain = ''] = String(email).split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** A pg `date` comes back as a Date at local midnight or as a string. */
export function isoDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function optionalText(v, max, key, errors) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') { errors[key] = 'text'; return null; }
  const t = v.trim();
  if (t.length > max) { errors[key] = `at most ${max} characters`; return null; }
  return t || null;
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}
