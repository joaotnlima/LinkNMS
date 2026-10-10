// The markup layer of a drawing (PRD-06) — pure: kinds, geometry rules, the
// markups-only version a save appends, and the wire body. No I/O.
//
// LinkNMS never authors drawings: "edit" on a PDF or DWG is a layer of markups
// kept on the record. Geometry is in SHEET UNITS — PDF points of the page as
// displayed at scale 1 (rotation applied), or the DWG preview's SVG units — so a length is isotropic and
// independent of the zoom the author drew at.

export const MARKUP_KINDS = Object.freeze(['cloud', 'arrow', 'text', 'measure', 'calibration']);
export const MARKUP_STATES = Object.freeze(['open', 'closed']);

/** Points each kind is drawn with. */
const POINTS = Object.freeze({ cloud: 2, arrow: 2, text: 1, measure: 2, calibration: 2 });
/** Kinds whose meaning IS their text ("arrow + note", a text box). */
const TEXT_REQUIRED = new Set(['arrow', 'text']);
/** Kinds that carry no remark of their own. */
const TEXT_FORBIDDEN = new Set(['measure', 'calibration']);

export const MAX_MARKUPS_PER_SAVE = 200;
const TEXT_MAX = 2000;
const PAGE_MAX = 200;
const COORD_MAX = 1e9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finiteCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_MAX;
}

/**
 * Validate one geometry for its kind. Returns an error sentence or null, and
 * the normalised geometry (only the keys the kind uses — nothing else is stored).
 */
export function validateGeometry(kind, geometry) {
  const want = POINTS[kind];
  if (!want) return { error: 'unknown kind', geometry: null };
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) {
    return { error: 'an object {points[, length_mm]}', geometry: null };
  }
  const pts = geometry.points;
  if (!Array.isArray(pts) || pts.length !== want) {
    return { error: `${kind} is drawn with exactly ${want} point${want === 1 ? '' : 's'}`, geometry: null };
  }
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !finiteCoord(p[0]) || !finiteCoord(p[1])) {
      return { error: `points are [x, y] pairs of finite numbers (|v| ≤ ${COORD_MAX})`, geometry: null };
    }
  }
  const out = { points: pts.map(([x, y]) => [x, y]) };
  if (want === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1] && kind !== 'cloud') {
    return { error: 'the two points must differ', geometry: null };
  }
  if (kind === 'cloud') {
    const w = Math.abs(pts[1][0] - pts[0][0]);
    const h = Math.abs(pts[1][1] - pts[0][1]);
    if (w === 0 || h === 0) return { error: 'a cloud needs an area', geometry: null };
  }
  if (kind === 'calibration') {
    const mm = geometry.length_mm;
    if (typeof mm !== 'number' || !Number.isFinite(mm) || mm <= 0 || mm > COORD_MAX) {
      return { error: 'calibration needs length_mm — the real length of the dimension, > 0', geometry: null };
    }
    out.length_mm = mm;
  } else if (geometry.length_mm !== undefined) {
    return { error: 'only a calibration carries length_mm', geometry: null };
  }
  return { error: null, geometry: out };
}

/**
 * Validate the body of saveDocumentMarkups. Returns {errors, drafts}: errors
 * keyed by field path (`markups[2].geometry`), drafts normalised for the store.
 */
export function validateMarkupSave(body) {
  const errors = {};
  const drafts = [];
  if (!Number.isInteger(body?.base_version_no) || body.base_version_no < 1) {
    errors.base_version_no = 'the version the markups were drawn on (≥ 1)';
  }
  if (body?.note !== undefined && body.note !== null
      && (typeof body.note !== 'string' || body.note.trim().length > TEXT_MAX)) {
    errors.note = `text up to ${TEXT_MAX} characters`;
  }
  const list = body?.markups;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MARKUPS_PER_SAVE) {
    errors.markups = `1–${MAX_MARKUPS_PER_SAVE} markups`;
    return { errors, drafts };
  }
  const seen = new Set();
  list.forEach((m, i) => {
    const at = (k) => `markups[${i}].${k}`;
    if (!UUID.test(m?.id ?? '')) errors[at('id')] = 'client-generated UUIDv7 required';
    else if (seen.has(m.id.toLowerCase())) errors[at('id')] = 'duplicate id in this save';
    else seen.add(m.id.toLowerCase());
    const page = typeof m?.page_or_layout === 'string' ? m.page_or_layout.trim() : '';
    if (!page || page.length > PAGE_MAX) errors[at('page_or_layout')] = `a page number or layout name (1–${PAGE_MAX} characters)`;
    if (!MARKUP_KINDS.includes(m?.kind)) {
      errors[at('kind')] = `one of ${MARKUP_KINDS.join(', ')}`;
      return;
    }
    const { error, geometry } = validateGeometry(m.kind, m.geometry);
    if (error) errors[at('geometry')] = error;
    const text = typeof m?.text === 'string' ? m.text.trim() : '';
    if (m?.text !== undefined && m?.text !== null && typeof m.text !== 'string') errors[at('text')] = 'text';
    else if (text.length > TEXT_MAX) errors[at('text')] = `up to ${TEXT_MAX} characters`;
    else if (TEXT_REQUIRED.has(m.kind) && !text) errors[at('text')] = `${m.kind === 'arrow' ? 'arrow + note' : 'a text markup'} needs its text`;
    else if (TEXT_FORBIDDEN.has(m.kind) && text) errors[at('text')] = `a ${m.kind} carries no text`;
    drafts.push({ id: m?.id, pageOrLayout: page, kind: m.kind, geometry, text: text || null });
  });
  return { errors, drafts };
}

/**
 * The version row a markups-only save appends: the base version's bytes,
 * re-pointed (same storage key, mime, size, sha256 — no byte copy), labelled
 * `markup_only` with the version it was drawn on.
 */
export function markupOnlyVersion(base, { note = null } = {}) {
  return {
    storageKey: base.storage_key,
    mime: base.mime,
    sizeBytes: Number(base.size_bytes),
    sha256: base.sha256,
    baseVersionNo: base.version_no,
    changeKind: 'markup_only',
    note: note && note.trim() ? note.trim() : null,
  };
}

/** Is `draft` (from a replayed save) the markup `row` already stored? */
export function sameMarkup(row, draft, { documentId, authorOrgId }) {
  return row.document_id === documentId
    && row.author_org_id === authorOrgId
    && row.page_or_layout === draft.pageOrLayout
    && row.kind === draft.kind
    && JSON.stringify(row.geometry) === JSON.stringify(draft.geometry)
    && (row.text ?? null) === (draft.text ?? null);
}

/** Close / re-open: the transition, or why not. Closing a closed markup is a no-op. */
export function markupTransition(state, action) {
  if (action === 'close') return state === 'closed' ? { ok: true, noop: true } : { ok: true, to: 'closed' };
  if (action === 'reopen') return state === 'open' ? { ok: true, noop: true } : { ok: true, to: 'open' };
  return { ok: false, reason: 'unknown action' };
}

/** Validate a link body: exactly one of question_id | nonconformity_id. */
export function validateMarkupLink(body) {
  const q = body?.question_id ?? null;
  const nc = body?.nonconformity_id ?? null;
  if ((q === null) === (nc === null)) return { errors: { link: 'exactly one of question_id, nonconformity_id' } };
  const id = q ?? nc;
  if (!UUID.test(id)) return { errors: { [q ? 'question_id' : 'nonconformity_id']: 'an id' } };
  return { errors: {}, link: q ? { questionId: q } : { nonconformityId: nc } };
}

/** Wire body (schema Markup). Optional links and the close stamp are absent when unset. */
export function markupBody(row) {
  return {
    id: row.id,
    document_id: row.document_id,
    version_no: row.version_no,
    page_or_layout: row.page_or_layout,
    kind: row.kind,
    geometry: row.geometry,
    ...(row.text ? { text: row.text } : {}),
    author: { person_id: row.author_person_id, org_id: row.author_org_id },
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    state: row.state,
    ...(row.closed_at ? { closed_at: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at } : {}),
    ...(row.question_id ? { question_id: row.question_id } : {}),
    ...(row.nonconformity_id ? { nonconformity_id: row.nonconformity_id } : {}),
  };
}
