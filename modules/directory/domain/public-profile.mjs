// Directory domain — the public company profile (/companies/{slug}, PRD-03
// R-10..R-16). Pure, no I/O.
//
// Three kinds of content, each labelled where it is shown:
//   on the record — counted by the directory read model from contract, task
//                   and change-order events (R-11). Build names only with the
//                   owner's consent; amounts never (R-12, D-07 spirit).
//   stated        — what the company wrote (description, licence, insurance,
//                   availability). Absent on an UNCLAIMED profile, which shows
//                   only what the record knows plus the claim path (R-16).
import { cardBody } from './ranking.mjs';
import { isoDate } from './profile.mjs';

const OPEN = new Set(['signed', 'active', 'provisionally_received']);

/** A build's state from its contracts with this company. */
export function buildState(statuses) {
  if (statuses.some((s) => OPEN.has(s))) return 'in_progress';
  if (statuses.includes('closed')) return 'closed';
  return 'terminated';
}

/**
 * @param {object} row       profile row + on-record counts (+ distance_km)
 * @param {{ builds: object[], portfolio: object[] }} extra
 *   builds: one row per project — statuses[], signed_on, finished_on,
 *   tasks_finished, tasks_on_time, consent_name (null without consent)
 */
export function publicProfileBody(row, { builds = [], portfolio = [] } = {}) {
  const card = cardBody(row, null);
  const claimed = Boolean(row.claimed);
  return {
    ...card,
    ...(claimed && row.description ? { description: row.description } : {}),
    ...(claimed ? { tags: row.tags ?? [], service_areas: row.service_areas ?? [] } : {}),
    ...(claimed && row.founded_year != null ? { founded_year: Number(row.founded_year) } : {}),
    on_linknms_since: new Date(row.created_at).toISOString().slice(0, 10),
    builds: builds.map((b) => {
      const state = buildState(b.statuses ?? []);
      return {
        state,
        signed_on: isoDate(b.signed_on),
        ...(state !== 'in_progress' && b.finished_on ? { finished_on: isoDate(b.finished_on) } : {}),
        ...(b.consent_name ? { name: b.consent_name } : {}),
        tasks_finished: Number(b.tasks_finished ?? 0),
        tasks_on_time: Number(b.tasks_on_time ?? 0),
      };
    }),
    // Stated entries only while claimed; platform entries only with consent
    // (the store already filters on owner_consent).
    portfolio: portfolio
      .filter((p) => (p.source === 'platform' ? p.owner_consent : claimed))
      .map(portfolioBody),
    claim: { available: !claimed },
  };
}

export function portfolioBody(p) {
  return {
    id: p.id,
    source: p.source,
    title: p.title,
    ...(p.municipality_code ? { municipality_code: p.municipality_code } : {}),
    ...(p.typology ? { typology: p.typology } : {}),
    specialties: p.specialties ?? [],
    ...(p.start_date ? { start_date: isoDate(p.start_date) } : {}),
    ...(p.end_date ? { end_date: isoDate(p.end_date) } : {}),
    ...(p.variance_wd != null ? { variance_wd: Number(p.variance_wd) } : {}),
    photo_document_ids: p.photo_document_ids ?? [],
  };
}
