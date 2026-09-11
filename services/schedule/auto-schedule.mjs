// Auto-schedule engine — compute missing stage dates from the dependency graph.
//
// Given a set of stages (some with user-set date anchors, some without) and a
// DAG of stage_dependency edges, this module fills in missing planned_start_date
// / planned_end_date by walking the graph forward.  It is PURE: no store, no
// ledger, no network — just input → output.  This makes it trivially testable
// under `node --test` and safe to call from both the service orchestration and
// a future endpoint.
//
// RULES (from ADR-0017 §5 and ADR-0020 typed-dependency semantics):
//   1. Only MISSING dates are filled — user-set dates are anchors, never moved.
//   2. Link types (ADR-0020) constrain the dependent's fields when filling
//      missing dates only:
//        starts_after (FS)  → dependent start = pred end + 1 day
//        starts_with  (SS)  → dependent start = pred start
//        ends_with    (FF)  → dependent end = pred end (start = end when the
//                             start is still missing — the 1-day rule stands)
//   3. Multiple constraints on the SAME field → the latest date wins
//      (most restrictive).
//   4. A stage with only one date set gets a 1-day default for the other end.
//   5. A stage with no dependencies and no dates stays undated (no anchor).
//   6. The graph is always a DAG (server-side rejectDependencyCycles ensures
//      this before any write), so no cycle handling is needed here.
//   7. No duration model exists — a computed stage defaults to 1 calendar day
//      (end = start) unless an ends_with constraint pulls its end later.
//   8. Calendar math uses UTC 'YYYY-MM-DD' days (same as plan-gantt.ts) — no
//      timezone drift, no DST surprises.
//
// Input shape mirrors the wire format from getPlan / authorPlan:
//   stages: [{ id, plannedStartDate, plannedEndDate,
//              dependsOn: [{ on: predId, type }] | [predId, …], … }, …]
//   `dependencies` (typed) wins when both shapes are present; each element may
//   be a bare pred id (compat = starts_after) or { on, type }.
//
// Output:
//   { computed: Map<stageId, { plannedStartDate, plannedEndDate }> }
//   Only stages whose dates were FILLED IN or NORMALIZED appear in the map.
//   Stages that already had both dates are omitted (they were anchors, not
//   computed).  Stages that remain undated (no deps + no anchor) are also
//   omitted.

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── date helpers (UTC calendar-day math, identical to plan-gantt.ts) ────────

function parseDay(iso) {
  if (!iso || typeof iso !== 'string' || !ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function formatDay(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso, n) {
  const ms = parseDay(iso);
  if (ms === null) return iso;
  return formatDay(ms + n * MS_PER_DAY);
}

function maxDate(...dates) {
  let latest = null;
  for (const d of dates) {
    const ms = parseDay(d);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest !== null ? formatDay(latest) : null;
}

// ── the engine ──────────────────────────────────────────────────────────────

/**
 * Compute missing stage dates from the dependency graph.
 *
 * @param {ReadonlyArray<{id: string, plannedStartDate?: string|null, plannedEndDate?: string|null, dependsOn?: ReadonlyArray<string | {on: string, type?: string}>, dependencies?: ReadonlyArray<{on: string, type?: string}>}>} stages
 * @returns {{ computed: Map<string, {plannedStartDate: string, plannedEndDate: string}> }}
 */
export function autoSchedule(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { computed: new Map() };
  }

  // Index stages by id for fast lookup, normalising each dependency entry to an
  // edge { on, type }. `dependencies` (typed, the getPlan shape) wins; fall back
  // to `dependsOn` (bare ids = starts_after) for callers wired pre-ADR-0020.
  const byId = new Map();
  for (const s of stages) {
    const rawEdges = s.dependencies ?? s.dependsOn ?? [];
    const edges = (Array.isArray(rawEdges) ? rawEdges : []).map((dep) => {
      if (typeof dep === 'string') return { on: dep, type: 'starts_after' };
      return { on: dep.on, type: dep.type ?? 'starts_after' };
    });
    byId.set(s.id, {
      id: s.id,
      startDate: s.plannedStartDate ?? null,
      endDate: s.plannedEndDate ?? null,
      edges,
    });
  }

  // Validate: every dependency target must exist.
  for (const s of byId.values()) {
    for (const edge of s.edges) {
      if (!byId.has(edge.on)) {
        throw new Error(`autoSchedule: stage "${s.id}" depends on unknown stage "${edge.on}"`);
      }
    }
  }

  // Work list: stages whose predecessors all have dates (or have no
  // predecessors) and that themselves lack a complete date pair.  We re-check
  // after each date computation because computing a date for stage X may
  // unblock stage Y that depends on X.
  const computed = new Map(); // stageId → { plannedStartDate, plannedEndDate }

  // Normalise half-dated stages: a stage with only start gets end = start,
  // a stage with only end gets start = end.  This happens BEFORE the forward
  // pass so that a half-dated anchor is a full anchor for its dependents.
  for (const s of byId.values()) {
    if (s.startDate && !s.endDate) {
      s.endDate = s.startDate;
      computed.set(s.id, { plannedStartDate: s.startDate, plannedEndDate: s.endDate });
    } else if (!s.startDate && s.endDate) {
      s.startDate = s.endDate;
      computed.set(s.id, { plannedStartDate: s.startDate, plannedEndDate: s.endDate });
    }
  }

  const dated = (s) => s.startDate != null && s.endDate != null;

  // Compute one stage's missing dates from its resolved edges. Returns null when
  // any predecessor is still undated (the stage can't be resolved yet).
  function computeFromEdges(s) {
    const startCands = [];
    const endCands = [];
    for (const edge of s.edges) {
      const pred = byId.get(edge.on);
      if (!pred) return null;
      if (edge.type === 'starts_after') {
        startCands.push(addDays(pred.endDate, 1));
      } else if (edge.type === 'starts_with') {
        startCands.push(pred.startDate);
      } else { // ends_with
        endCands.push(pred.endDate);
      }
    }
    const startFloor = maxDate(...startCands);
    const endFloor = maxDate(...endCands);
    // All predecessors dated but no numeric constraint on either field cannot
    // happen (each edge contributes to startCands or endCands); guard anyway.
    if (startFloor == null && endFloor == null) return null;

    let start;
    let end;
    if (startFloor != null) {
      start = startFloor;
      end = endFloor != null ? maxDate(endFloor, start) : start;
    } else {
      // ends_with only — the 1-day rule stands: start = end.
      end = endFloor;
      start = end;
    }
    return { start, end };
  }

  // Fixed-point iteration: keep going until no more dates are computed.
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of byId.values()) {
      // Already fully dated (anchor or previously computed) → skip.
      if (dated(s)) continue;

      // Stages with no predecessors and no dates stay undated (no anchor).
      if (s.edges.length === 0) continue;

      // Check that ALL predecessors are dated (a normalized half-date counts:
      // it is a full anchor by the time the forward pass needs it).
      const allPredsDated = s.edges.every((edge) => {
        const pred = byId.get(edge.on);
        return pred != null && dated(pred);
      });
      if (!allPredsDated) continue;

      const dates = computeFromEdges(s);
      if (dates == null) continue;

      s.startDate = dates.start;
      s.endDate = dates.end;

      computed.set(s.id, { plannedStartDate: s.startDate, plannedEndDate: s.endDate });
      changed = true;
    }
  }

  return { computed };
}
