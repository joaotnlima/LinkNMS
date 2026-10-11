// PRD-10 view mapping — baselines, what a task waits on, its acceptance
// checklist, the daily log and the site calendar. Pure: the server's numbers
// and lists in, the screen's words out. No rule is decided here: who may start,
// what overlaps and what a day holds are the planning module's answers.
// Run: node --test src/lib/v2/execution-view.test.mjs

// ── wire shapes (openapi Baseline, WaitingOn, DailyLog, SiteCalendar) ────────

export interface V2Baseline {
  id: string;
  contract_id: string;
  version: number;
  reason: 'award' | 'contract_signed' | 'change_order';
  root_task_ids: string[];
  branch_name?: string;
  row_count?: number;
  is_current: boolean;
  taken_by?: { person_id?: string; org_id?: string };
  taken_by_org_name?: string;
  taken_at: string;
}

export interface V2WaitingOn {
  task_id: string;
  name: string;
  status: string;
  needs: 'finished' | 'started';
  met: boolean;
}

export interface V2DailyLogEntry {
  id: string;
  kind: 'presence' | 'weather' | 'work' | 'issue' | 'photo';
  date: string;
  org_id?: string; org_name?: string; headcount?: number;
  weather?: string; temperature_c?: number;
  task_id?: string; task_name?: string;
  location_id?: string; location_name?: string;
  document_id?: string; version_no?: number;
  percent?: number; note?: string;
  recorded_by: { person_id: string; org_id: string };
  recorded_by_org_name?: string;
  recorded_at: string;
}

export interface V2DailyLog {
  project_id: string;
  date: string;
  on_site: V2DailyLogEntry[];
  headcount_total: number;
  weather?: V2DailyLogEntry;
  work: V2DailyLogEntry[];
  issues: V2DailyLogEntry[];
  photos: V2DailyLogEntry[];
  entries: V2DailyLogEntry[];
}

export interface V2DailyLogDay {
  date: string; org_count?: number; headcount_total?: number; weather?: string;
  work_count?: number; issue_count?: number; photo_count?: number;
}

export interface V2SiteCalendar {
  project_id: string;
  from: string;
  to: string;
  presence: Array<{
    task_id: string; task_name: string; org_id: string; org_name?: string;
    location_id: string | null; location_name?: string; from: string; to: string; days: string[];
  }>;
  overlaps: Array<{
    location_id: string; location_name?: string; from: string; to: string; days: number;
    tasks: Array<{ task_id: string; task_name: string; org_id: string; org_name?: string }>;
  }>;
  unassigned_count?: number;
}

// ── dates ────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Feb 2027" from YYYY-MM-DD (or an RFC 3339 stamp). */
export function dayWords(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()];
}

// ── E-1 baseline selector ────────────────────────────────────────────────────

const REASON: Record<V2Baseline['reason'], string> = {
  award: 'taken at award',
  contract_signed: 'taken at signature',
  change_order: 'change order accepted',
};

export interface BaselineOption { id: string; label: string; detail: string; isCurrent: boolean }

/** The selector's options, as the server ordered them (newest first). */
export function toBaselineOptions(items: V2Baseline[]): BaselineOption[] {
  return items.map((b) => ({
    id: b.id,
    label: `${b.branch_name ?? 'Branch'} · v${b.version}${b.is_current ? ' (current)' : ''}`,
    detail: [REASON[b.reason] ?? b.reason, dayWords(b.taken_at), b.taken_by_org_name ? `by ${b.taken_by_org_name}` : null]
      .filter(Boolean).join(' · '),
    isCurrent: b.is_current,
  }));
}

// ── E-5 what a task waits on ─────────────────────────────────────────────────

const STATUS: Record<string, string> = {
  not_started: 'not started', in_progress: 'in progress', blocked: 'blocked', done: 'done', verified: 'verified',
};
export const statusWord = (s: string): string => STATUS[s] ?? s;

export interface WaitingLine { taskId: string; name: string; state: string; needs: string; met: boolean }

export function toWaitingLines(list: V2WaitingOn[] | undefined): WaitingLine[] {
  return (list ?? []).map((w) => ({
    taskId: w.task_id,
    name: w.name,
    state: statusWord(w.status),
    needs: w.needs === 'finished' ? 'must be finished' : 'must have started',
    met: w.met,
  }));
}

/** True when starting now jumps the queue (the server will ask for a reason). */
export function startNeedsReason(list: V2WaitingOn[] | undefined, status: string): boolean {
  return status === 'not_started' && (list ?? []).some((w) => !w.met);
}

// ── E-7 daily log ────────────────────────────────────────────────────────────

export const WEATHER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'sunny', label: 'Sunny' }, { value: 'cloudy', label: 'Cloudy' }, { value: 'rain', label: 'Rain' },
  { value: 'heavy_rain', label: 'Heavy rain' }, { value: 'wind', label: 'Wind' }, { value: 'frost', label: 'Frost' },
  { value: 'snow', label: 'Snow' }, { value: 'heat', label: 'Heat' },
];
export const weatherWord = (w?: string): string => WEATHER_OPTIONS.find((o) => o.value === w)?.label ?? (w ?? '');

/** What the phone page collected, before it becomes entries. */
export interface CaptureForm {
  presence: Array<{ orgId: string; headcount: number | null }>;
  weather: string | null;
  temperatureC: number | null;
  work: Array<{ taskId: string; note: string; percent: number | null }>;
  issues: Array<{ note: string; taskId: string | null; locationId: string | null }>;
  photos: Array<{ documentId: string; taskId: string | null; locationId: string | null; caption: string }>;
}

/**
 * The capture as the contract's entries (`DailyLogEntryCreate[]`). Empty rows
 * are dropped; `newId` mints each client id (idempotent retries reuse them).
 */
export function captureEntries(form: CaptureForm, newId: () => string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const text = (s: string) => s.trim();
  for (const p of form.presence) {
    if (p.headcount != null && p.orgId) out.push({ id: newId(), kind: 'presence', org_id: p.orgId, headcount: p.headcount });
  }
  if (form.weather) {
    out.push({ id: newId(), kind: 'weather', weather: form.weather, ...(form.temperatureC != null ? { temperature_c: form.temperatureC } : {}) });
  }
  for (const w of form.work) {
    if (!w.taskId) continue;
    out.push({
      id: newId(), kind: 'work', task_id: w.taskId,
      ...(text(w.note) ? { note: text(w.note) } : {}), ...(w.percent != null ? { percent: w.percent } : {}),
    });
  }
  for (const i of form.issues) {
    if (!text(i.note)) continue;
    out.push({
      id: newId(), kind: 'issue', note: text(i.note),
      ...(i.taskId ? { task_id: i.taskId } : {}), ...(i.locationId ? { location_id: i.locationId } : {}),
    });
  }
  for (const ph of form.photos) {
    out.push({
      id: newId(), kind: 'photo', document_id: ph.documentId,
      ...(ph.taskId ? { task_id: ph.taskId } : {}), ...(ph.locationId ? { location_id: ph.locationId } : {}),
      ...(text(ph.caption) ? { note: text(ph.caption) } : {}),
    });
  }
  return out;
}

/** D-14: no offline capture — the sentence the page shows when the connection drops. */
export const OFFLINE_MESSAGE = 'No connection. LinkNMS does not save anything offline — keep this page open and send it when you are back online.';

/** One line per entry of a day, as the record reads it. */
export function entryLine(e: V2DailyLogEntry): string {
  switch (e.kind) {
    case 'presence': return `${e.org_name ?? 'An organisation'} on site · ${e.headcount} ${e.headcount === 1 ? 'person' : 'people'}`;
    case 'weather': return `Weather: ${weatherWord(e.weather)}${e.temperature_c != null ? `, ${e.temperature_c} °C` : ''}`;
    case 'work': return `${e.task_name ?? 'A task'}${e.percent != null ? ` · ${e.percent}%` : ''}${e.note ? ` — ${e.note}` : ''}`;
    case 'issue': return `${e.note ?? ''}${e.task_name ? ` · ${e.task_name}` : ''}${e.location_name ? ` · ${e.location_name}` : ''}`;
    case 'photo': return `Photo${e.note ? `: ${e.note}` : ''}${e.task_name ? ` · ${e.task_name}` : ''}${e.location_name ? ` · ${e.location_name}` : ''}`;
    default: return '';
  }
}

export function daySummaryWords(d: V2DailyLogDay): string {
  const parts = [
    d.org_count ? `${d.org_count} org${d.org_count === 1 ? '' : 's'} · ${d.headcount_total ?? 0} on site` : null,
    d.weather ? weatherWord(d.weather) : null,
    d.work_count ? `${d.work_count} work` : null,
    d.issue_count ? `${d.issue_count} issue${d.issue_count === 1 ? '' : 's'}` : null,
    d.photo_count ? `${d.photo_count} photo${d.photo_count === 1 ? '' : 's'}` : null,
  ];
  return parts.filter(Boolean).join(' · ') || 'Nothing recorded';
}

// ── E-10/E-11 site calendar ──────────────────────────────────────────────────

export interface CalendarLane { key: string; label: string; org: string; days: Set<string>; tasks: string[] }
export interface CalendarPlace { locationId: string | null; label: string; lanes: CalendarLane[] }

/** Lanes per location (organisation within it), for a day-column grid. */
export function calendarPlaces(cal: V2SiteCalendar): CalendarPlace[] {
  const places = new Map<string, CalendarPlace>();
  for (const p of cal.presence) {
    const key = p.location_id ?? '—';
    if (!places.has(key)) {
      places.set(key, { locationId: p.location_id, label: p.location_name ?? (p.location_id ? 'Location' : 'No location'), lanes: [] });
    }
    const place = places.get(key)!;
    let lane = place.lanes.find((l) => l.key === p.org_id);
    if (!lane) {
      lane = { key: p.org_id, label: p.org_name ?? 'Organisation', org: p.org_id, days: new Set(), tasks: [] };
      place.lanes.push(lane);
    }
    for (const d of p.days) lane.days.add(d);
    lane.tasks.push(p.task_name);
  }
  return [...places.values()].sort((a, b) => (a.locationId === null ? 1 : b.locationId === null ? -1 : a.label.localeCompare(b.label)));
}

/** Every working day that has someone on site, in order (the grid's columns). */
export function calendarDays(cal: V2SiteCalendar): string[] {
  return [...new Set(cal.presence.flatMap((p) => p.days))].sort();
}

/** "Roof · 3–5 Feb 2027 · Obra Nova (Roof structure) and Eletro Mota (Roof electrics)". */
export function overlapWords(o: V2SiteCalendar['overlaps'][number]): string {
  const span = o.from === o.to ? dayWords(o.from) : `${dayWords(o.from)} – ${dayWords(o.to)}`;
  const who = o.tasks.map((t) => `${t.org_name ?? 'An organisation'} (${t.task_name})`).join(' and ');
  return `${o.location_name ?? 'Same location'} · ${span} · ${who}`;
}

/** The grid cells an overlap covers, keyed `location|org|day` (to mark them). */
export function clashCells(cal: V2SiteCalendar): Set<string> {
  const out = new Set<string>();
  for (const o of cal.overlaps) {
    for (const p of cal.presence) {
      if (p.location_id !== o.location_id || !o.tasks.some((t) => t.task_id === p.task_id)) continue;
      for (const d of p.days) if (d >= o.from && d <= o.to) out.add(`${o.location_id}|${p.org_id}|${d}`);
    }
  }
  return out;
}
