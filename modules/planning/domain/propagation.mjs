// The link engine (doc 05 §3–§4, D-21/D-22/D-32). Pure: takes the plan in
// memory, returns what would move — the store decides what to persist.
//
// Rules implemented verbatim from the doc:
//   end→start  successor.start  = next working day after pred.finish, + lag
//   start→start successor.start = pred.start + lag
//   end→end    successor.finish = pred.finish + lag
//   start→end  successor.finish = pred.start + lag        (SF, API-only)
//   · a link is rigid (holds in both directions: push AND pull);
//   · several incoming links ⇒ the successor sits at the LATEST position;
//   · the successor keeps its duration;
//   · a link touching an undated anchor does nothing;
//   · a started row keeps its actual start (only its finish moves) —
//     a violated start constraint becomes a sequence_warning;
//   · a done row never moves;
//   · a summary moves as its whole subtree, its envelope is the anchor.
import {
  nextWorkingDay, shiftWorkingDays, spanFinish, spanStart,
  durationWd, workingDaysDelta,
} from './calendar.mjs';

/**
 * Detect whether adding `candidate` {predecessorId, successorId} to `links`
 * creates a cycle. Returns the cycle path (task ids) or null.
 */
export function cyclePath(links, candidate) {
  const succs = new Map();
  for (const l of [...links, candidate]) {
    if (!succs.has(l.predecessorId)) succs.set(l.predecessorId, []);
    succs.get(l.predecessorId).push(l.successorId);
  }
  // A cycle through the new link must pass successor → … → predecessor.
  const stack = [[candidate.successorId, [candidate.predecessorId, candidate.successorId]]];
  const seen = new Set();
  while (stack.length) {
    const [node, path] = stack.pop();
    if (node === candidate.predecessorId) return path;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of succs.get(node) ?? []) stack.push([next, [...path, next]]);
  }
  return null;
}

/** children index of the task map (Map id → task with .parentId). */
function childrenIndex(tasks) {
  const kids = new Map();
  for (const t of tasks.values()) {
    if (!t.parentId) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t.id);
  }
  return kids;
}

/** All descendant ids of `rootId` (not including it). */
export function descendantIds(tasks, rootId) {
  const kids = childrenIndex(tasks);
  const out = [];
  const stack = [...(kids.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}

/**
 * Effective span of every row: actuals override plans on leaves; a summary is
 * the envelope of its descendants (nulls where honestly unknown).
 * Returns Map id → {start, finish} (either side may be null).
 */
export function effectiveSpans(tasks) {
  const kids = childrenIndex(tasks);
  const memo = new Map();
  const spanOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = tasks.get(id);
    const childIds = kids.get(id) ?? [];
    let span;
    if (childIds.length === 0) {
      span = { start: t.actualStart ?? t.start ?? null, finish: t.actualFinish ?? t.finish ?? null };
    } else {
      let start = null;
      let finish = null;
      for (const c of childIds) {
        const s = spanOf(c);
        if (s.start && (!start || s.start < start)) start = s.start;
        if (s.finish && (!finish || s.finish > finish)) finish = s.finish;
      }
      span = { start, finish };
    }
    memo.set(id, span);
    return span;
  };
  for (const id of tasks.keys()) spanOf(id);
  return memo;
}

/** True when the row (or its subtree) still moves at all. */
function isDone(task) {
  return Boolean(task.actualFinish);
}

/**
 * Where do `task`'s incoming links want it? Returns {impliedStart,
 * finishOnly} or null when no resolvable constraint exists.
 * `finishOnly` is the latest finish required by end-anchored links — used
 * when the start is pinned by an actual.
 */
function requiredPosition({ task, span, incoming, spans, calendar }) {
  const duration = span.start && span.finish
    ? durationWd(calendar, span.start, span.finish)
    : (task.durationWd ?? 1);
  let impliedStart = null;
  let requiredFinish = null;
  for (const link of incoming) {
    const predSpan = spans.get(link.predecessorId);
    if (!predSpan) continue;
    const anchor = link.fromAnchor === 'end' ? predSpan.finish : predSpan.start;
    if (!anchor) continue; // undated / open external anchor: link is inert
    if (link.toAnchor === 'start') {
      const req = link.fromAnchor === 'end'
        ? shiftWorkingDays(calendar, nextWorkingDay(calendar, anchor), link.lagWd)
        : shiftWorkingDays(calendar, anchor, link.lagWd);
      if (!impliedStart || req > impliedStart) impliedStart = req;
    } else {
      const reqFinish = shiftWorkingDays(calendar, anchor, link.lagWd);
      if (!requiredFinish || reqFinish > requiredFinish) requiredFinish = reqFinish;
      const req = spanStart(calendar, reqFinish, Math.max(duration, task.kind === 'milestone' ? 0 : 1));
      if (!impliedStart || req > impliedStart) impliedStart = req;
    }
  }
  if (!impliedStart && !requiredFinish) return null;
  return { impliedStart, requiredFinish, duration };
}

/**
 * Re-apply every link downstream of `seedIds` after a change.
 *
 * @param {{tasks: Map, links: Array, calendar: object, seedIds: string[]}} plan
 * @returns {{moves: Array<{id, start, finish, causeTaskId}>,
 *            warnings: Array<{id, code}>}}
 *   `moves` carries the NEW planned dates; `tasks` is left untouched — the
 *   caller owns persistence. Warnings do not stop the walk (doc 05: a link
 *   that can no longer hold flags the row, never blocks the plan).
 */
export function propagate({ tasks, links, calendar, seedIds }) {
  const incomingOf = new Map();
  const outgoingOf = new Map();
  for (const l of links) {
    if (!incomingOf.has(l.successorId)) incomingOf.set(l.successorId, []);
    incomingOf.get(l.successorId).push(l);
    if (!outgoingOf.has(l.predecessorId)) outgoingOf.set(l.predecessorId, []);
    outgoingOf.get(l.predecessorId).push(l);
  }

  const work = new Map(tasks); // shallow copy; moved rows are replaced
  const moves = new Map();
  const warnings = [];
  let spans = effectiveSpans(work);

  const applyDates = (id, start, finish, causeTaskId) => {
    const t = work.get(id);
    work.set(id, { ...t, start, finish });
    moves.set(id, { id, start, finish, causeTaskId });
  };

  // Kahn's walk over the part of the DAG reachable from the seeds. Links are
  // acyclic by construction (cyclePath gate at creation), so this terminates.
  const queue = [...new Set(seedIds)];
  const visited = new Set();
  while (queue.length) {
    const predId = queue.shift();
    if (visited.has(predId)) continue;
    visited.add(predId);
    spans = effectiveSpans(work);
    for (const link of outgoingOf.get(predId) ?? []) {
      const succ = work.get(link.successorId);
      if (!succ || succ.deletedAt) continue;
      const span = spans.get(succ.id);
      if (!span?.start && !span?.finish) continue; // undated successor: inert
      if (isDone(succ)) continue;                  // done rows never move
      const required = requiredPosition({
        task: succ, span, incoming: incomingOf.get(succ.id) ?? [], spans, calendar,
      });
      if (!required?.impliedStart) continue;

      const kids = descendantIds(work, succ.id);
      if (kids.length > 0) {
        // Summary: shift the whole subtree by the delta of its envelope.
        if (!span.start) continue;
        const delta = workingDaysDelta(calendar, span.start, required.impliedStart);
        if (delta === 0) continue;
        let movedAny = false;
        for (const cid of kids) {
          const child = work.get(cid);
          if (descendantIds(work, cid).length > 0) continue; // leaves carry the dates
          if (!child.start || isDone(child)) continue;
          if (child.actualStart) {
            warnings.push({ id: cid, code: 'held_at_actual_start' });
            continue;
          }
          const s = shiftWorkingDays(calendar, child.start, delta);
          const f = child.finish
            ? spanFinish(calendar, s, durationWd(calendar, child.start, child.finish))
            : null;
          applyDates(cid, s, f, predId);
          movedAny = true;
        }
        if (movedAny) queue.push(succ.id, ...kids);
        continue;
      }

      if (succ.actualStart) {
        // Started: the start is pinned; only end-anchored links still act.
        if (required.impliedStart > succ.actualStart) {
          warnings.push({ id: succ.id, code: 'held_at_actual_start' });
        }
        if (required.requiredFinish && required.requiredFinish !== span.finish) {
          if (required.requiredFinish < succ.actualStart) {
            warnings.push({ id: succ.id, code: 'started_before_predecessor_allowed' });
          } else {
            applyDates(succ.id, succ.start ?? succ.actualStart, required.requiredFinish, predId);
            queue.push(succ.id);
          }
        }
        continue;
      }

      const newStart = required.impliedStart;
      const newFinish = succ.kind === 'milestone'
        ? newStart
        : spanFinish(calendar, newStart, Math.max(required.duration, 1));
      if (newStart === span.start && newFinish === span.finish) continue;
      applyDates(succ.id, newStart, newFinish, predId);
      queue.push(succ.id);
    }
  }

  return { moves: [...moves.values()], warnings };
}

/**
 * The lag a link must store so it holds the successor exactly where the user
 * dropped it (doc 05 §4 "dragging a linked successor changes its lag").
 */
export function lagFor({ link, predSpan, succStart, succFinish, calendar }) {
  const anchor = link.fromAnchor === 'end' ? predSpan.finish : predSpan.start;
  if (!anchor) return link.lagWd;
  if (link.toAnchor === 'start') {
    if (!succStart) return link.lagWd;
    const zero = link.fromAnchor === 'end' ? nextWorkingDay(calendar, anchor) : anchor;
    return workingDaysDelta(calendar, zero, succStart);
  }
  if (!succFinish) return link.lagWd;
  return workingDaysDelta(calendar, anchor, succFinish);
}
