// The plan's critical path — pure, ONE rule for the whole product (PRD-01
// "Critical path" overlay, PRD-02 T-5/T-13 tender alert; audit S4b).
//
// THE RULE (domain/tender-window.mjs#criticalLeaves states it as a probe): a
// leaf is critical when a ONE-working-day slip of its finish moves the project
// finish — links are rigid (D-22), so the slip travels exactly as the
// propagation engine (domain/propagation.mjs) would carry it; done rows never
// move; a started row keeps its actual start. A summary is critical when it
// contains a critical leaf — the founder's reading (LINA-404): "the critical
// path is 1.1 (1.1.2 plus 1.1.1) and then 1.2", the parents light too.
//
// Probing every leaf costs a propagation each (quadratic on a whole plan), so
// this module answers the question in ONE linear pass over the slip graph: an
// event (a leaf's finish moves; a row moves whole; a summary's envelope edge
// moves) is critical when it reaches a leaf that sets the project finish. A
// link carries a slip only when it DRIVES its successor — its required
// position is the latest of the successor's incoming links and the successor
// sits there (doc 05 §3), so a one-day slip of a driving predecessor moves it
// and a slack one does not. A summary's links act whenever its envelope edge
// moves (rigid links hold on summaries too). The tender alert asks the same
// function about its covered leaves (tender-window.mjs). critical-path.test.mjs
// checks this pass against a propagate-per-leaf probe on generated plans.
import { nextWorkingDay, shiftWorkingDays, spanStart, durationWd } from './calendar.mjs';
import { effectiveSpans } from './propagation.mjs';

/** @returns {Set<string>} the critical rows of the plan: leaves and their ancestors */
export function criticalTaskIds({ tasks, links, calendar }) {
  const kids = new Map();
  for (const t of tasks.values()) {
    if (!t.parentId || !tasks.has(t.parentId)) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t.id);
  }
  const isLeaf = (id) => !(kids.get(id) ?? []).length;
  const spans = effectiveSpans(tasks);
  let projectFinish = null;
  for (const id of tasks.keys()) {
    const f = isLeaf(id) ? spans.get(id)?.finish : null;
    if (f && (!projectFinish || f > projectFinish)) projectFinish = f;
  }
  if (!projectFinish) return new Set();

  // Which links drive their successor (start-wise and finish-wise).
  const incoming = new Map();
  const outgoing = new Map();
  for (const l of links) {
    if (!tasks.has(l.predecessorId) || !tasks.has(l.successorId)) continue;
    if (!incoming.has(l.successorId)) incoming.set(l.successorId, []);
    incoming.get(l.successorId).push(l);
    if (!outgoing.has(l.predecessorId)) outgoing.set(l.predecessorId, []);
    outgoing.get(l.predecessorId).push(l);
  }
  const drives = new Map(); // link → { start: bool, finish: bool }
  for (const [succId, ins] of incoming) {
    const task = tasks.get(succId);
    const span = spans.get(succId) ?? {};
    const duration = span.start && span.finish ? durationWd(calendar, span.start, span.finish) : (task.durationWd ?? 1);
    const reqs = ins.map((link) => {
      const pred = spans.get(link.predecessorId);
      const anchor = pred ? (link.fromAnchor === 'end' ? pred.finish : pred.start) : null;
      if (!anchor) return { link, start: null, finish: null };
      if (link.toAnchor === 'start') {
        const start = link.fromAnchor === 'end'
          ? shiftWorkingDays(calendar, nextWorkingDay(calendar, anchor), link.lagWd)
          : shiftWorkingDays(calendar, anchor, link.lagWd);
        return { link, start, finish: null };
      }
      const finish = shiftWorkingDays(calendar, anchor, link.lagWd);
      return { link, finish, start: spanStart(calendar, finish, Math.max(duration, task.kind === 'milestone' ? 0 : 1)) };
    });
    const maxStart = reqs.reduce((m, r) => (r.start && (!m || r.start > m) ? r.start : m), null);
    const maxFinish = reqs.reduce((m, r) => (r.finish && (!m || r.finish > m) ? r.finish : m), null);
    for (const r of reqs) {
      drives.set(r.link, {
        start: Boolean(r.start) && r.start === maxStart, reqStart: maxStart,
        finish: Boolean(r.finish) && r.finish === maxFinish, reqFinish: maxFinish,
      });
    }
  }

  const memo = new Map();
  const crit = (kind, id) => {
    const key = `${kind}:${id}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false); // the slip graph is acyclic; this only guards re-entry
    const value = evaluate(kind, id);
    memo.set(key, value);
    return value;
  };

  // A slip carried by `link` into its successor. A link drives when its
  // required position is the latest of the successor's links AND the
  // successor sits there (a row held later by its own children does not move
  // forward with it — the engine would pull it back, not push it).
  const effect = (link) => {
    const d = drives.get(link);
    const succ = tasks.get(link.successorId);
    const span = spans.get(link.successorId) ?? {};
    if (!d || !succ || succ.deletedAt || succ.actualFinish) return false;
    if (!span.start && !span.finish) return false;
    if (!isLeaf(succ.id)) return d.start && d.reqStart === span.start && crit('SUB', succ.id);
    if (succ.actualStart) return link.toAnchor === 'end' && d.finish && d.reqFinish === span.finish && crit('F', succ.id);
    return d.start && d.reqStart === span.start && crit('W', succ.id);
  };
  const outgoingVia = (id, anchor) => (outgoing.get(id) ?? []).some((l) => l.fromAnchor === anchor && effect(l));
  const setsFinish = (id) => spans.get(id)?.finish === projectFinish;
  const leavesUnder = (id) => {
    const out = [];
    const stack = [...(kids.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop();
      if (isLeaf(c)) out.push(c); else stack.push(...kids.get(c));
    }
    return out;
  };
  const movable = (id) => {
    const t = tasks.get(id);
    return Boolean(t.start) && !t.actualFinish && !t.actualStart;
  };

  // A row's envelope edge moves when every leaf defining it moves with it.
  const parentFinish = (id) => {
    const p = tasks.get(id)?.parentId;
    if (!p || !tasks.has(p)) return false;
    const f = spans.get(id)?.finish;
    if (!f || f !== spans.get(p)?.finish) return false;
    const tied = (kids.get(p) ?? []).filter((c) => spans.get(c)?.finish === f).length;
    return tied === 1 && crit('EF', p);
  };
  const parentStart = (id) => {
    const p = tasks.get(id)?.parentId;
    if (!p || !tasks.has(p)) return false;
    const s = spans.get(id)?.start;
    if (!s || s !== spans.get(p)?.start) return false;
    const tied = (kids.get(p) ?? []).filter((c) => spans.get(c)?.start === s).length;
    return tied === 1 && crit('ES', p);
  };

  function evaluate(kind, id) {
    switch (kind) {
      case 'F': // a leaf's finish moves one working day (the probe; a started leaf pushed)
        return setsFinish(id) || outgoingVia(id, 'end') || parentFinish(id);
      case 'W': // a leaf pushed whole
        return crit('F', id) || outgoingVia(id, 'start') || parentStart(id);
      case 'EF': // a summary's envelope finish moves
        return outgoingVia(id, 'end') || parentFinish(id);
      case 'ES': // a summary's envelope start moves
        return outgoingVia(id, 'start') || parentStart(id);
      case 'SUB': { // a summary shifts as a whole: its movable leaves move, envelopes follow
        if (leavesUnder(id).some((c) => movable(c) && crit('W', c))) return true;
        const envelopeMoves = (sid, edge) => {
          const at = spans.get(sid)?.[edge];
          return Boolean(at) && leavesUnder(sid).filter((c) => spans.get(c)?.[edge] === at).every(movable);
        };
        const summaries = [id];
        for (let k = 0; k < summaries.length; k += 1) for (const c of kids.get(summaries[k]) ?? []) if (!isLeaf(c)) summaries.push(c);
        if (summaries.some((sid) => (envelopeMoves(sid, 'finish') && outgoingVia(sid, 'end'))
          || (envelopeMoves(sid, 'start') && outgoingVia(sid, 'start')))) return true;
        return (envelopeMoves(id, 'finish') && parentFinish(id)) || (envelopeMoves(id, 'start') && parentStart(id));
      }
      default:
        return false;
    }
  }

  const out = new Set();
  for (const [id, t] of tasks) {
    if (!isLeaf(id) || t.actualFinish) continue;
    const span = spans.get(id);
    if (!span?.start || !span?.finish) continue;
    if (!crit('F', id)) continue;
    for (let cur = id; cur && tasks.has(cur) && !out.has(cur); cur = tasks.get(cur).parentId) out.add(cur);
  }
  return out;
}
