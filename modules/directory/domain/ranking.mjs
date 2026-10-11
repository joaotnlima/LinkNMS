// Directory domain — who comes first in a search (D-46), facets, the public
// card, and keyset paging over the ranked list. Pure, no I/O.
//
// THE RULE (D-46, founder 2026-10-10). Ranking within a specialty comes ONLY
// from clients verified by the platform: a client that signed a contract with
// the company on LinkNMS. A company is RANKED when it has ≥ 1 such client
// (a later termination does not undo it). Ranked companies come first, by
//   1. verified clients            (more first)
//   2. on-time rate of the tasks they finished under those contracts,
//      smoothed (x + 1) / (y + 2) so 1 of 1 does not beat 45 of 50
//   3. builds with a signed contract (more first)
//   4. distance                    (nearer first; unknown last)
//   5. specialty match             (exact before related)
// then every UNRANKED company ("No verified clients yet") by distance, then
// specialty match. Name and id only break ties. Completeness, stated data and
// payment are not inputs — there is no parameter through which they could be.
// Ratings (D-16) do not exist; when they do, only ratings from clients with an
// award to the company may join step 2.

/** The codes a specialty query matches: itself, its parent, its children. */
export function specialtyFamily(code, taxonomy) {
  if (!code) return null;
  const node = taxonomy.find((s) => s.code === code);
  if (!node) return null;
  const codes = new Set([code]);
  if (node.parent_code) codes.add(node.parent_code);
  for (const s of taxonomy) if (s.parent_code === code) codes.add(s.code);
  return { code, parent: node.parent_code ?? null, codes: [...codes] };
}

/** exact = lists the searched code; related = its parent or a child. */
export function specialtyMatch(specialties, family) {
  if (!family) return null;
  if ((specialties ?? []).includes(family.code)) return 'exact';
  if ((specialties ?? []).some((c) => family.codes.includes(c))) return 'related';
  return null;
}

/** On-the-record facts of one candidate row (counts from the read model). */
export function onRecord(row) {
  const verified = Number(row.verified_clients ?? 0);
  return {
    ranked: verified > 0,
    verified_clients: verified,
    builds: Number(row.builds ?? 0),
    tasks_finished: Number(row.tasks_finished ?? 0),
    tasks_on_time: Number(row.tasks_on_time ?? 0),
    change_orders_raised: Number(row.change_orders_raised ?? 0),
    change_orders_approved: Number(row.change_orders_approved ?? 0),
  };
}

/** Stated facts for the card — absent on an unclaimed profile (R-16). */
export function statedFacts(row) {
  if (!row.claimed) return undefined;
  return {
    licence_number_given: Boolean(row.declared_impic_number?.trim()),
    ...(row.declared_impic_class ? { impic_class: row.declared_impic_class } : {}),
    insurance_given: Boolean(row.declared_insurance?.trim()),
    ...(row.available_from ? { available_from: String(row.available_from).slice(0, 10) } : {}),
    portfolio_count: Number(row.portfolio_count ?? 0),
  };
}

/** DirectoryCard — public. Never an amount; stated data only when claimed. */
export function cardBody(row, family) {
  const match = specialtyMatch(row.specialties, family);
  const claimed = Boolean(row.claimed);
  return {
    org_id: row.org_id,
    slug: row.slug,
    display_name: row.display_name,
    ...(row.kind ? { kind: row.kind } : {}),
    claimed,
    ...(row.base_municipality_code ? { base_municipality_code: row.base_municipality_code } : {}),
    ...(row.distance_km != null ? { distance_km: Math.round(Number(row.distance_km) * 10) / 10 } : {}),
    ...(claimed && row.service_radius_km != null ? { service_radius_km: Number(row.service_radius_km) } : {}),
    ...(claimed && row.team_size_band ? { team_size_band: row.team_size_band } : {}),
    specialties: row.specialties ?? [],
    ...(match ? { specialty_match: match } : {}),
    record: onRecord(row),
    ...(claimed ? { stated: statedFacts(row) } : {}),
  };
}

/**
 * The sort key of a card — an array compared element by element, ascending.
 * Every "more is better" fact is negated. Ends with the org id, so the key is
 * unique and the order total (keyset paging relies on it).
 */
export function rankKey(card) {
  const r = card.record;
  const distance = card.distance_km ?? Number.MAX_SAFE_INTEGER;
  const match = card.specialty_match === 'exact' ? 0 : card.specialty_match === 'related' ? 1 : 2;
  const name = String(card.display_name ?? '').toLowerCase();
  if (r.ranked) {
    const onTime = (r.tasks_on_time + 1) / (r.tasks_finished + 2);
    return [0, -r.verified_clients, -round6(onTime), -r.builds, distance, match, name, card.org_id];
  }
  return [1, 0, 0, 0, distance, match, name, card.org_id];
}

export function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function sortCards(cards) {
  return cards
    .map((card) => ({ card, key: rankKey(card) }))
    .sort((x, y) => compareKeys(x.key, y.key));
}

/** Facet filters (applied AFTER facets are counted). */
export function applyFacetFilters(cards, { workTypes = [], proof = [], sizes = [], claimed = null } = {}) {
  return cards.filter((c) => {
    if (workTypes.length && !workTypes.some((w) => c.specialties.includes(w))) return false;
    if (proof.includes('on_record') && c.record.builds === 0) return false;
    if (proof.includes('licence') && !c.stated?.licence_number_given) return false;
    if (proof.includes('portfolio') && !(c.stated?.portfolio_count > 0)) return false;
    if (sizes.length && !sizes.includes(c.team_size_band)) return false;
    if (claimed !== null && c.claimed !== claimed) return false;
    return true;
  });
}

/**
 * Facet counts over the result set before facet filters. Work types are the
 * children of the searched family (or every top-level specialty when the
 * search names none — a card counts for a parent through any of its children).
 */
export function facetCounts(cards, taxonomy, family) {
  const parent = family ? (family.parent ?? family.code) : null;
  const types = parent
    ? taxonomy.filter((s) => s.parent_code === parent)
    : taxonomy.filter((s) => !s.parent_code);
  const childrenOf = (code) => taxonomy.filter((s) => s.parent_code === code).map((s) => s.code);
  const work_types = types.map((t) => {
    const codes = parent ? [t.code] : [t.code, ...childrenOf(t.code)];
    return { code: t.code, count: cards.filter((c) => c.specialties.some((s) => codes.includes(s))).length };
  }).filter((w) => w.count > 0);
  const size = [];
  for (const band of ['1', '2-5', '6-20', '21-50', '50+']) {
    const count = cards.filter((c) => c.team_size_band === band).length;
    if (count) size.push({ band, count });
  }
  return {
    work_types,
    proof: {
      on_record: cards.filter((c) => c.record.builds > 0).length,
      licence: cards.filter((c) => c.stated?.licence_number_given).length,
      portfolio: cards.filter((c) => c.stated?.portfolio_count > 0).length,
    },
    size,
    claimed: cards.filter((c) => c.claimed).length,
  };
}

/** Keyset page over the sorted list: items strictly after the cursor key. */
export function pageAfter(sorted, cursor, limit) {
  const after = cursor ? decodeCursor(cursor) : null;
  const rest = after ? sorted.filter((x) => compareKeys(x.key, after) > 0) : sorted;
  const page = rest.slice(0, limit);
  const more = rest.length > limit;
  return {
    items: page.map((x) => x.card),
    nextCursor: more ? encodeCursor(page[page.length - 1].key) : null,
  };
}

export function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** A malformed cursor is a client error, not a fresh first page. */
export function decodeCursor(raw) {
  try {
    const key = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (Array.isArray(key) && key.length === 8) return key;
  } catch { /* fall through */ }
  return null;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
