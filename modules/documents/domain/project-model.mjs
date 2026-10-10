// The shared project model (PRD-07, D-45) — pure: the record-side edits an
// organisation may make on the model, how concurrent drafts merge, what a
// version's record looked like, and the wire bodies. No I/O.
//
// D-45: LinkNMS never writes into the IFC. A "model edit" is record-side only —
// element ↔ task links and issue pins, keyed by the element's IFC GlobalId so
// they survive a re-upload — saved as a new model version (`change_kind:
// edit`) that re-points the bytes of the current version (no byte copy).
//
// Link history is append-only in effect: a link row carries the version it was
// added in and, once removed, the version it was removed in. The record at
// version N is every row with added ≤ N < removed. That one shape answers the
// current links, the record changes between two versions (M-16), what a
// restore re-applies (M-17) and which elements a draft's base has gone stale on
// (M-14).

/** An IFC GlobalId: 22 characters of the IFC base-64 alphabet. */
export const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;
export const MAX_CHANGES = 500;
export const MAX_PIN_ELEMENTS = 200;
export const MAX_PIN_TASKS = 20;
const NOTE_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EDIT_OPS = Object.freeze(['link', 'unlink', 'pin', 'close_pin']);

/**
 * Validate a draft save (`saveModelEdits`). Returns {errors, edit} — edit is
 * normalised: global ids as sent (case matters in IFC), task ids lower-cased.
 */
export function validateModelEdits(body) {
  const errors = {};
  const edit = { baseVersionNo: null, note: null, changes: [], resolutions: new Map() };
  if (!Number.isInteger(body?.base_version_no) || body.base_version_no < 1) errors.base_version_no = 'the version the draft was made on';
  else edit.baseVersionNo = body.base_version_no;
  if (typeof body?.note !== 'string' || !body.note.trim()) errors.note = 'required — what changed and why goes on the record';
  else if (body.note.trim().length > NOTE_MAX) errors.note = `up to ${NOTE_MAX} characters`;
  else edit.note = body.note.trim();
  const changes = body?.changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) {
    errors.changes = `1–${MAX_CHANGES} changes`;
  } else {
    changes.forEach((c, i) => {
      const at = `changes[${i}]`;
      if (!c || !EDIT_OPS.includes(c.op)) { errors[`${at}.op`] = `one of ${EDIT_OPS.join(', ')}`; return; }
      if (c.op === 'link' || c.op === 'unlink') {
        if (!GLOBAL_ID.test(c.global_id ?? '')) errors[`${at}.global_id`] = 'an IFC GlobalId (22 characters)';
        if (!UUID.test(c.task_id ?? '')) errors[`${at}.task_id`] = 'the task id';
        edit.changes.push({ op: c.op, globalId: c.global_id, taskId: String(c.task_id ?? '').toLowerCase() });
      } else if (c.op === 'pin') {
        const p = c.pin ?? {};
        const gids = Array.isArray(p.global_ids) ? [...new Set(p.global_ids)] : null;
        const tids = Array.isArray(p.task_ids) ? [...new Set(p.task_ids.map((t) => String(t).toLowerCase()))] : [];
        if (!UUID.test(p.id ?? '')) errors[`${at}.pin.id`] = 'client-generated UUIDv7';
        if (!gids || gids.length < 1 || gids.length > MAX_PIN_ELEMENTS || gids.some((g) => !GLOBAL_ID.test(g ?? ''))) {
          errors[`${at}.pin.global_ids`] = `1–${MAX_PIN_ELEMENTS} IFC GlobalIds`;
        }
        if (tids.length > MAX_PIN_TASKS || tids.some((t) => !UUID.test(t))) errors[`${at}.pin.task_ids`] = `up to ${MAX_PIN_TASKS} task ids`;
        if (typeof p.text !== 'string' || !p.text.trim() || p.text.trim().length > NOTE_MAX) {
          errors[`${at}.pin.text`] = `text of 1–${NOTE_MAX} characters`;
        }
        edit.changes.push({ op: 'pin', pin: { id: String(p.id ?? '').toLowerCase(), globalIds: gids ?? [], taskIds: tids, text: String(p.text ?? '').trim() } });
      } else {
        if (!UUID.test(c.pin_id ?? '')) errors[`${at}.pin_id`] = 'the pin id';
        edit.changes.push({ op: 'close_pin', pinId: String(c.pin_id ?? '').toLowerCase() });
      }
    });
  }
  const res = body?.resolutions;
  if (res !== undefined && res !== null) {
    if (typeof res !== 'object' || Array.isArray(res)) errors.resolutions = 'an object {global_id: "mine" | "theirs"}';
    else {
      for (const [gid, choice] of Object.entries(res)) {
        if (!GLOBAL_ID.test(gid) || !['mine', 'theirs'].includes(choice)) { errors.resolutions = 'an object {global_id: "mine" | "theirs"}'; break; }
        edit.resolutions.set(gid, choice);
      }
    }
  }
  return { errors, edit };
}

/** The elements a change touches. */
export function elementsOf(change, pinsById = new Map()) {
  if (change.op === 'pin') return change.pin.globalIds;
  if (change.op === 'close_pin') return pinsById.get(change.pinId)?.global_ids ?? [];
  return [change.globalId];
}

/** Links live at version `n` (added ≤ n < removed). */
export function linksAt(rows, n) {
  return rows.filter((r) => r.added_in_version <= n && (r.removed_in_version == null || r.removed_in_version > n));
}

/** Current links: never removed. */
export function liveLinks(rows) {
  return rows.filter((r) => r.removed_in_version == null);
}

/**
 * M-14 — elements whose record changed after `base`: a link added or removed in
 * a later version, a pin created or closed in a later version.
 */
export function touchedSince(rows, pins, base) {
  const out = new Map();
  const mark = (gid, version, by) => { if (!out.has(gid)) out.set(gid, { version, by }); };
  for (const r of rows) {
    if (r.added_in_version > base) mark(r.global_id, r.added_in_version, r.created_by_org_id);
    if (r.removed_in_version != null && r.removed_in_version > base) mark(r.global_id, r.removed_in_version, r.removed_by_org_id);
  }
  for (const p of pins) {
    if (p.version_no > base || (p.closed_in_version != null && p.closed_in_version > base)) {
      for (const gid of p.global_ids) mark(gid, p.version_no, p.author_org_id);
    }
  }
  return out;
}

/**
 * M-8 — the viewer's edit scope on the model.
 *   whole   — the model's author and the project owner;
 *   taskIds — rows in the viewer's live D-33 scope (planning task port);
 *   globalIds — elements linked (now) to one of those rows.
 */
export function editScope({ whole, taskIds = [], links = [] }) {
  const tasks = new Set(taskIds);
  if (whole) return { whole: true, taskIds: tasks, globalIds: null };
  const globalIds = new Set(liveLinks(links).filter((l) => tasks.has(l.task_id)).map((l) => l.global_id));
  return { whole: false, taskIds: tasks, globalIds };
}

export function inScope(scope, gid) {
  return scope.whole || Boolean(scope.globalIds?.has(gid));
}

/**
 * Check every change against the scope (D-33 / M-8, server-side). Returns the
 * refusals as {index, reason}; empty when all are allowed.
 *   link / unlink — the row must be in scope and the element too (a company
 *     may only re-link elements already on its rows; the author / owner any);
 *   pin — every element in scope; the tasks it names are only references;
 *   close_pin — the pin's author org, or an editor of every pinned element.
 */
export function scopeRefusals(changes, scope, { pinsById = new Map(), orgId, projectTaskIds = new Set() } = {}) {
  const out = [];
  changes.forEach((c, index) => {
    if (c.op === 'link' || c.op === 'unlink') {
      if (!projectTaskIds.has(c.taskId)) out.push({ index, reason: 'not a task of this build' });
      else if (!scope.whole && !scope.taskIds.has(c.taskId)) out.push({ index, reason: 'the task is outside your edit scope' });
      else if (!inScope(scope, c.globalId)) out.push({ index, reason: 'the element is not linked to a task you edit' });
    } else if (c.op === 'pin') {
      const bad = c.pin.globalIds.filter((g) => !inScope(scope, g));
      if (bad.length) out.push({ index, reason: `elements outside your edit scope: ${bad.slice(0, 5).join(', ')}` });
      else if (c.pin.taskIds.some((t) => !projectTaskIds.has(t))) out.push({ index, reason: 'a pinned task is not a task of this build' });
    } else {
      const pin = pinsById.get(c.pinId);
      if (!pin) out.push({ index, reason: 'no such issue on this model' });
      else if (pin.author_org_id !== orgId && !pin.global_ids.every((g) => inScope(scope, g))) {
        out.push({ index, reason: 'only the issue\'s author or an editor of its elements closes it' });
      }
    }
  });
  return out;
}

/**
 * M-14 — merge a draft made on `base` onto the latest record. A change whose
 * elements nobody touched since `base` applies; an overlap needs the caller's
 * element-level choice (`resolutions`: mine → apply, theirs → drop). Never
 * last-write-wins: an unresolved overlap is returned as a conflict.
 * Then the changes are reduced against the live record (linking a linked pair,
 * unlinking an absent one, re-pinning an id → no-ops).
 * @returns {{ conflicts: {global_id, version, by_org_id}[], apply: {links, unlinks, pins, closes}, dropped: number }}
 */
export function mergeDraft({ changes, base, rows, pins, resolutions = new Map() }) {
  const touched = touchedSince(rows, pins, base);
  const pinsById = new Map(pins.map((p) => [p.id, p]));
  const conflicts = new Map();
  const kept = [];
  let dropped = 0;
  for (const c of changes) {
    const overlap = elementsOf(c, pinsById).filter((g) => touched.has(g));
    if (!overlap.length) { kept.push(c); continue; }
    const unresolved = overlap.filter((g) => !resolutions.has(g));
    if (unresolved.length) {
      for (const g of unresolved) {
        const t = touched.get(g);
        conflicts.set(g, { global_id: g, version: t.version, by_org_id: t.by ?? null });
      }
      continue;
    }
    if (overlap.some((g) => resolutions.get(g) === 'theirs')) dropped += 1;
    else kept.push(c);
  }
  const apply = { links: [], unlinks: [], pins: [], closes: [] };
  if (conflicts.size) return { conflicts: [...conflicts.values()], apply, dropped };

  const live = new Map(liveLinks(rows).map((r) => [`${r.global_id}|${r.task_id}`, r]));
  const pending = new Set();
  for (const c of kept) {
    const key = `${c.globalId}|${c.taskId}`;
    if (c.op === 'link') {
      if (!live.has(key) && !pending.has(key)) { apply.links.push({ globalId: c.globalId, taskId: c.taskId }); pending.add(key); }
    } else if (c.op === 'unlink') {
      if (live.has(key) && !apply.unlinks.some((u) => u.id === live.get(key).id)) apply.unlinks.push({ id: live.get(key).id });
    } else if (c.op === 'pin') {
      if (!pinsById.has(c.pin.id) && !apply.pins.some((p) => p.id === c.pin.id)) apply.pins.push(c.pin);
    } else if (pinsById.get(c.pinId)?.state === 'open' && !apply.closes.includes(c.pinId)) {
      apply.closes.push(c.pinId);
    }
  }
  return { conflicts: [], apply, dropped };
}

export function changeCount(apply) {
  return apply.links.length + apply.unlinks.length + apply.pins.length + apply.closes.length;
}

/**
 * M-17 — what restoring version `n` re-applies on the record: links live now
 * but not at n are removed; links live at n but not now are added back. Issue
 * pins are never removed (an issue stays on the record).
 */
export function restorePlan(rows, n) {
  const then = new Set(linksAt(rows, n).map((r) => `${r.global_id}|${r.task_id}`));
  const now = liveLinks(rows);
  const nowKeys = new Set(now.map((r) => `${r.global_id}|${r.task_id}`));
  const remove = now.filter((r) => !then.has(`${r.global_id}|${r.task_id}`)).map((r) => ({ id: r.id }));
  const add = [];
  for (const key of then) {
    if (!nowKeys.has(key)) {
      const [globalId, taskId] = key.split('|');
      add.push({ globalId, taskId });
    }
  }
  return { remove, add };
}

/**
 * M-16 — record changes between two versions (from < to): links added and
 * removed, issues pinned and closed. File-level changes (added / removed /
 * property-changed elements) come from the two IFC files themselves, read by
 * the viewer — the server never parses IFC.
 */
export function recordDiff(rows, pins, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const a = new Set(linksAt(rows, lo).map((r) => `${r.global_id}|${r.task_id}`));
  const b = new Set(linksAt(rows, hi).map((r) => `${r.global_id}|${r.task_id}`));
  const split = (k) => { const [global_id, task_id] = k.split('|'); return { global_id, task_id }; };
  return {
    from: lo,
    to: hi,
    links_added: [...b].filter((k) => !a.has(k)).map(split),
    links_removed: [...a].filter((k) => !b.has(k)).map(split),
    pins_added: pins.filter((p) => p.version_no > lo && p.version_no <= hi).map(pinBody),
    pins_closed: pins.filter((p) => p.closed_in_version != null && p.closed_in_version > lo && p.closed_in_version <= hi).map(pinBody),
  };
}

// ── wire ────────────────────────────────────────────────────────────────

export function elementLinkBody(r) {
  return {
    global_id: r.global_id,
    task_id: r.task_id,
    added_in_version: r.added_in_version,
    linked_by: { org_id: r.created_by_org_id, person_id: r.created_by_person_id },
    linked_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

export function pinBody(p) {
  return {
    id: p.id,
    global_ids: p.global_ids,
    task_ids: p.task_ids ?? [],
    text: p.text,
    state: p.state,
    version_no: p.version_no,
    author: { org_id: p.author_org_id, person_id: p.author_person_id },
    created_at: p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at,
    ...(p.closed_in_version != null ? { closed_in_version: p.closed_in_version } : {}),
  };
}

/** The viewer's scope on the wire (M-1 "Edit my elements" shows when it is not none). */
export function scopeBody(scope, { isAuthor, isOwner }) {
  if (scope.whole) return { kind: isAuthor ? 'author' : (isOwner ? 'owner' : 'whole'), task_ids: [], element_count: null };
  const count = scope.globalIds?.size ?? 0;
  return { kind: scope.taskIds.size ? 'tasks' : 'none', task_ids: [...scope.taskIds], element_count: count };
}

/** Element counts per task on the live record (M-3 legend). */
export function elementCounts(links) {
  const out = new Map();
  for (const l of liveLinks(links)) out.set(l.task_id, (out.get(l.task_id) ?? 0) + 1);
  return out;
}
