# ADR-0020 — Typed plan dependencies (starts-after / starts-with / ends-with) + Gantt connectors

- **Status:** Accepted
- **Date:** 2026-09-11
- **Issue:** LINA-251 (Gantt View)
- **Supersedes/extends:** ADR-0017 Annex 2 (untyped `dependsOn`), revisit trigger in ADR-0005 §"Revisit when"

## Context

Direct plan authoring (ADR-0017 Annex 2) shipped an **untyped** predecessor
graph: `schedule.stage_dependency(stage_id, depends_on_stage_id)`, authored as
`dependsOn: string[]`, semantically hard-coded to finish-to-start. The founder
now asks (LINA-251) to remove the generic "depends on" and let the user express
*how* one stage blocks another — starts-after / starts-with / ends-with — and
to see the links as arrows in the Gantt.

## Decision

### 1. Link type vocabulary

One typed link per ordered stage pair. Three types, mapped to the classic PM
relations:

| `dep_type` | UI label | Classic | Meaning for scheduling |
|---|---|---|---|
| `starts_after` | Starts after | FS (finish-to-start) | dependent starts only after predecessor **ends** |
| `starts_with` | Starts with | SS (start-to-start) | dependent starts together with predecessor's **start** |
| `ends_with` | Ends with | FF (finish-to-finish) | dependent ends together with predecessor's **end** |

Deliberately excluded from v1: start-to-finish (rare in practice) and lag/lead
offsets (`lag_days`). Both are additive later; do not pre-build.

### 2. Storage — migration 0010

`ALTER TABLE schedule.stage_dependency ADD COLUMN dep_type text NOT NULL
DEFAULT 'starts_after' CHECK (dep_type IN
('starts_after','starts_with','ends_with'))`.

- PK stays `(stage_id, depends_on_stage_id)` — **one link per pair**; the type
  qualifies the link. Two different typed links between the same pair are
  rejected by design (matches how MS Project / Asana model it).
- Existing rows become `starts_after` — byte-exact preservation of today's
  implied semantics. No backfill needed beyond the default.
- 0007's freeze-guard trigger and grants carry over untouched. Never edit an
  applied migration (prod checksum gate) — this is a new file, 0010.

### 3. Wire contract

**`:author` payload** — each `dependsOn` entry is either a bare string key
(compat alias for `{ key, type: 'starts_after' }`) or an object:

```json
{ "key": "found", "type": "starts_with" }
```

Unknown `type` → `400 invalid_dependency_type`. Duplicate target key within one
stage's list → `400 duplicate_dependency`. Existing error codes
(`self_dependency`, `unknown_dependency`, `409 dependency_cycle`) unchanged.

**Read side (`stageTree`)** — emit a new field alongside the legacy one:

```json
"dependencies": [ { "on": "<stageId>", "type": "starts_after" } ]
```

Legacy `dependsOn: string[]` (ids only) **stays dual-emitted** until the FE
consumes `dependencies` in prod; the FE slice may delete the legacy emission in
its own PR once switched (monorepo, but separate PRs/deploys — never break the
read shape between the two merges).

**Import path** — unchanged. Excel bare refs remain `starts_after` via the
column default. Typed import tokens are a possible later extension.

### 4. Cycle rule — one DAG regardless of type

All three types are treated as ordering edges on a single directed graph; any
cycle is rejected (`409 dependency_cycle`), exactly as today. Trade-off: a
mutual `starts_with` pair is arguably coherent in real PM tools, but allowing
type-aware cycle exceptions complicates validation, auto-schedule, and the
mental model for near-zero v1 value. Revisit only on user demand.

### 5. Auto-schedule engine

`services/schedule/auto-schedule.mjs` (pure, currently unwired) learns the
types when filling **missing** dates only (anchored dates never move):

- `starts_after`: start = latest predecessor end + 1 day (today's rule)
- `starts_with`: start = predecessor start
- `ends_with`: end = predecessor end (and start = end if start missing —
  1-day-stage rule 6 still applies)

When multiple typed predecessors constrain the same stage, take the **latest**
resulting date per field (most restrictive wins).

### 6. Gantt connectors (FE)

The timeline canvas (`PlanGrid.tsx`) is absolutely-positioned divs; arrows are
drawn in a new **SVG overlay layer** (`position:absolute; inset:0;
pointer-events:none`) above the bars. Per link, an elbow path with an arrowhead
marker, anchored by type:

- `starts_after`: predecessor bar **right** edge → dependent bar **left** edge
- `starts_with`: predecessor **left** edge → dependent **left** edge
- `ends_with`: predecessor **right** edge → dependent **right** edge

Geometry is computed by pure helpers in `app/src/lib/plan-gantt.ts` (bar geom
in, path points out) with unit tests. Links where either endpoint has no dates
are not drawn. Connectors re-render live during drag.

**Authoring UI** — the drawer's "Depends on" control is replaced by a typed
picker: each linked predecessor chip carries a type selector with the three
labels above; default `starts_after`. Client cycle pre-check (`detectCycle`)
unchanged (edges, type-blind).

### 7. Explicitly out of scope (v1)

- **Runtime progression enforcement** (refusing `stage_progress` advancement
  while a predecessor is incomplete). LINA-251 is about expressing and seeing
  the constraint in the plan; enforcement is a product decision touching the
  live-record write path — raise separately if wanted.
- Lag/lead days, start-to-finish, critical-path highlighting, dependent-drag
  ripple (dragging a predecessor does not push dependents).

## Consequences

- Semantics-preserving for every existing plan (all current links = FS).
- `plan-authoring.ts` FE model migrates `dependsOn: string[]` → typed edges;
  hydrate/toWire/choice helpers change shape but not structure.
- Two-slice delivery: BE (migration 0010 + `:author`/read + engine + tests)
  then FE (typed picker + SVG connectors + tests), FE blocked on BE.
