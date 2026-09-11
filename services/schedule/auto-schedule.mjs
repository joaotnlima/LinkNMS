// Auto-schedule engine — compute missing stage dates from the dependency graph.
//
// Given a set of stages (some with user-set date anchors, some without) and a
// DAG of stage_dependency edges, this module fills in missing planned_start_date
// / planned_end_date by walking the graph forward.  It is PURE: no store, no
// ledger, no network — just input → output.  This makes it trivially testable
// under `node --test` and safe to call from both the service orchestration and
// a future endpoint.
//
// RULES (from ADR-0017 §5 and the dependency semantics):
//   1. A predecessor must FINISH before its dependent starts — the day after
//      all predecessors finish is the earliest a stage can begin.
//   2. User-set dates are anchors — they are never moved.
//   3. A stage with only one date set gets a 1-day default for the other end.
//   4. A stage with no dependencies and no dates stays undated (no anchor).
//   5. The graph is always a DAG (server-side rejectDependencyCycles ensures
//      this before any write), so no cycle handling is needed here.
//   6. No duration model exists — every computed stage is 1 calendar day.
//   7. Calendar math uses UTC 'YYYY-MM-DD' days (same as plan-gantt.ts) — no
//      timezone drift, no DST surprises.
//
// Input shape mirrors the wire format from getPlan / authorPlan:
//   stages:  [{ id, plannedStartDate, plannedEndDate, dependsOn: [predId, …] }, …]
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
 * @param {ReadonlyArray<{id: string, plannedStartDate?: string|null, plannedEndDate?: string|null, dependsOn?: ReadonlyArray<string>}>} stages
 * @returns {{ computed: Map<string, {plannedStartDate: string, plannedEndDate: string}> }}
 */
export function autoSchedule(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { computed: new Map() };
  }

  // Index stages by id for fast lookup.
  const byId = new Map();
  for (const s of stages) {
    byId.set(s.id, {
      id: s.id,
      startDate: s.plannedStartDate ?? null,
      endDate: s.plannedEndDate ?? null,
      predecessors: [...(s.dependsOn ?? [])],
    });
  }

  // Validate: every dependsOn target must exist.
  for (const s of byId.values()) {
    for (const pred of s.predecessors) {
      if (!byId.has(pred)) {
        throw new Error(`autoSchedule: stage "${s.id}" depends on unknown stage "${pred}"`);
      }
    }
  }

  // Build in-degree map (number of predecessors whose dates are NOT yet resolved
  // to an end date).  This drives the fixed-point iteration.
  //
  // We also need a reverse map: for each stage, which stages depend on it
  // (dependents), so we can re-evaluate dependents when a predecessor gets its
  // end date filled in.
  const dependents = new Map(); // stageId → Set<stageId>
  for (const s of byId.values()) {
    for (const pred of s.predecessors) {
      if (!dependents.has(pred)) dependents.set(pred, new Set());
      dependents.get(pred).add(s.id);
    }
  }

  // Work list: stages whose predecessors all have end dates (or have no
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

  // Fixed-point iteration: keep going until no more dates are computed.
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of byId.values()) {
      // Already fully dated (anchor or previously computed) → skip.
      if (s.startDate && s.endDate) continue;

      // Stages with no predecessors and no dates stay undated (no anchor).
      if (s.predecessors.length === 0) continue;

      // Check that ALL predecessors have end dates.
      const allPredsDated = s.predecessors.every((predId) => {
        const pred = byId.get(predId);
        return pred && pred.endDate != null;
      });
      if (!allPredsDated) continue;

      // Compute: start = day after the latest predecessor's end; end = start
      // (1-day default duration).
      const predEndDates = s.predecessors
        .map((predId) => byId.get(predId).endDate)
        .filter(Boolean);
      const latestPredEnd = maxDate(...predEndDates);

      if (latestPredEnd == null) continue;

      s.startDate = addDays(latestPredEnd, 1);
      s.endDate = s.startDate;

      computed.set(s.id, { plannedStartDate: s.startDate, plannedEndDate: s.endDate });
      changed = true;
    }
  }

  return { computed };
}
