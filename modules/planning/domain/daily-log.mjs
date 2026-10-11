// The site's daily log (PRD-10 E-7..E-9; flow B13). Pure: validation of a
// capture and the read shapes of a day.
//
// A day is the append-only list of what was recorded for it. Presence and
// weather read as "the latest wins" (per organisation / per day) — a
// correction is a newer entry, the earlier one stays in `entries` (D-23: the
// record shows, it does not rewrite).

export const KINDS = Object.freeze(['presence', 'weather', 'work', 'issue', 'photo']);
export const WEATHER = Object.freeze(['sunny', 'cloudy', 'rain', 'heavy_rain', 'wind', 'frost', 'snow', 'heat']);
export const MAX_ENTRIES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The site day of the path: a real date, not in the future. */
export function validateLogDate(date, today) {
  if (!ISO_DATE.test(date ?? '') || Number.isNaN(Date.parse(date))) return 'a date YYYY-MM-DD';
  if (date > today) return 'a site day today or earlier';
  return null;
}

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validate and normalise one capture. Field errors are keyed `entries[i].field`.
 * @returns {{errors: object, entries: Array<object>}}
 */
export function validateEntries(body) {
  const errors = {};
  const list = body?.entries;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ENTRIES) {
    return { errors: { entries: `1 to ${MAX_ENTRIES} entries` }, entries: [] };
  }
  const ids = new Set();
  const entries = list.map((e, i) => {
    const err = (field, msg) => { errors[`entries[${i}].${field}`] = msg; };
    if (!UUID.test(e?.id ?? '')) err('id', 'client-generated UUIDv7 required');
    else if (ids.has(e.id.toLowerCase())) err('id', 'used twice in this capture');
    else ids.add(e.id.toLowerCase());
    if (!KINDS.includes(e?.kind)) { err('kind', KINDS.join(', ')); return null; }
    const out = {
      id: e.id, kind: e.kind, orgId: null, headcount: null, weather: null, temperatureC: null,
      taskId: null, locationId: null, documentId: null, percent: null, note: null,
    };
    const uuidField = (field, key, required) => {
      if (e[field] == null) { if (required) err(field, 'required for this kind'); return; }
      if (!UUID.test(e[field])) err(field, 'an id'); else out[key] = e[field];
    };
    if (e.note != null) {
      if (typeof e.note !== 'string' || !e.note.trim() || e.note.length > 2000) err('note', '1 to 2000 characters');
      else out.note = e.note.trim();
    }
    switch (e.kind) {
      case 'presence':
        uuidField('org_id', 'orgId', true);
        if (!intIn(e.headcount, 0, 999)) err('headcount', '0..999 people'); else out.headcount = e.headcount;
        break;
      case 'weather':
        if (!WEATHER.includes(e.weather)) err('weather', WEATHER.join(', ')); else out.weather = e.weather;
        if (e.temperature_c != null) {
          if (!intIn(e.temperature_c, -30, 50)) err('temperature_c', '-30..50 °C'); else out.temperatureC = e.temperature_c;
        }
        break;
      case 'work':
        uuidField('task_id', 'taskId', true);
        if (e.percent != null) {
          if (!intIn(e.percent, 0, 100)) err('percent', '0..100'); else out.percent = e.percent;
        }
        break;
      case 'issue':
        if (out.note == null && !errors[`entries[${i}].note`]) err('note', 'say what the issue is');
        uuidField('task_id', 'taskId', false);
        uuidField('location_id', 'locationId', false);
        break;
      case 'photo':
        uuidField('document_id', 'documentId', true);
        uuidField('task_id', 'taskId', false);
        uuidField('location_id', 'locationId', false);
        break;
      default:
    }
    for (const [field, kinds] of Object.entries(ONLY_ON)) {
      if (e[field] != null && !kinds.includes(e.kind)) err(field, `not on a ${e.kind} entry`);
    }
    return out;
  });
  return { errors, entries: entries.filter(Boolean) };
}

const ONLY_ON = {
  org_id: ['presence'], headcount: ['presence'], weather: ['weather'], temperature_c: ['weather'],
  task_id: ['work', 'issue', 'photo'], location_id: ['issue', 'photo'], document_id: ['photo'], percent: ['work'],
};

/** Same entry content? (idempotent replay of a client id). */
export function sameEntry(stored, e, date) {
  return stored.log_date === date && stored.kind === e.kind
    && (stored.org_id ?? null) === e.orgId && (stored.headcount ?? null) === e.headcount
    && (stored.weather ?? null) === e.weather && (stored.temperature_c ?? null) === e.temperatureC
    && (stored.task_id ?? null) === e.taskId && (stored.location_id ?? null) === e.locationId
    && (stored.document_id ?? null) === e.documentId && (stored.percent ?? null) === e.percent
    && (stored.note ?? null) === e.note;
}

/** Wire DailyLogEntry from a stored row (snake_case) + display names. */
export function entryBody(r, names = {}) {
  const pick = (k, v) => (v == null ? {} : { [k]: v });
  return {
    id: r.id,
    kind: r.kind,
    date: r.log_date,
    ...pick('org_id', r.org_id),
    ...pick('org_name', r.org_id ? names.orgs?.get(r.org_id) : null),
    ...pick('headcount', r.headcount),
    ...pick('weather', r.weather),
    ...pick('temperature_c', r.temperature_c),
    ...pick('task_id', r.task_id),
    ...pick('task_name', r.task_id ? names.tasks?.get(r.task_id) : null),
    ...pick('location_id', r.location_id),
    ...pick('location_name', r.location_id ? names.locations?.get(r.location_id) : null),
    ...pick('document_id', r.document_id),
    ...pick('version_no', r.version_no),
    ...pick('percent', r.percent),
    ...pick('note', r.note),
    recorded_by: { person_id: r.recorded_by_person_id, org_id: r.recorded_by_org_id },
    ...pick('recorded_by_org_name', names.orgs?.get(r.recorded_by_org_id)),
    recorded_at: r.recorded_at?.toISOString?.() ?? r.recorded_at,
  };
}

/** One day (wire DailyLog) from its entries in recorded order. */
export function dayBody({ projectId, date, rows, names }) {
  const entries = rows.map((r) => entryBody(r, names));
  const latestBy = new Map();
  let weather;
  for (const e of entries) {
    if (e.kind === 'presence') latestBy.set(e.org_id, e);
    if (e.kind === 'weather') weather = e;
  }
  // A correction to 0 says the organisation was not on site after all.
  const onSite = [...latestBy.values()].filter((e) => e.headcount > 0);
  return {
    project_id: projectId,
    date,
    on_site: onSite,
    headcount_total: onSite.reduce((n, e) => n + e.headcount, 0),
    ...(weather ? { weather } : {}),
    work: entries.filter((e) => e.kind === 'work'),
    issues: entries.filter((e) => e.kind === 'issue'),
    photos: entries.filter((e) => e.kind === 'photo'),
    entries,
  };
}

/** The list of days (wire DailyLogDay), newest first, from every entry of the window. */
export function daySummaries(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.log_date)) byDay.set(r.log_date, []);
    byDay.get(r.log_date).push(r);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => {
      const presence = new Map();
      let weather;
      const count = { work: 0, issue: 0, photo: 0 };
      for (const r of list) {
        if (r.kind === 'presence') presence.set(r.org_id, r.headcount);
        else if (r.kind === 'weather') weather = r.weather;
        else count[r.kind] += 1;
      }
      return {
        date,
        org_count: [...presence.values()].filter((h) => h > 0).length,
        headcount_total: [...presence.values()].reduce((n, h) => n + h, 0),
        ...(weather ? { weather } : {}),
        work_count: count.work,
        issue_count: count.issue,
        photo_count: count.photo,
      };
    });
}
