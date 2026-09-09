# ADR-0015 — The record home (M14) and the schedule/budget/scope/safety pillars

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Full-Stack Architect (Technical Lead)
- **Context issue:** LINA-223 — Rebuild the record home (project dashboard) to
  pen M14. **Parent:** LINA-219 (Create build / project). **Anchors:** ADR-0002
  (hash-chain ledger), ADR-0005 (schedule service), ADR-0009 (pen palette), the
  B3 contract (`slice-b3-live-record-materials-contract.md`), and the standing
  no-invented-data rule (LINA-57: surfaces render persisted data or fail
  honestly — no fixtures).

## Context

`app/src/app/projects/[id]/page.tsx` was "Surface 1", an R0 pre-pen dashboard
citing the old design §7 / FR8–FR9. The founder flagged it out of LINA-219 as
"not in the designs": the portal is the pen's **mobile-web bootstrap flow**
(M-series), and the governing frame for the post-creation project home is
**"S · M14 · The record, live"** in `cowork/pen/linkNMS.pen`.

M14 is a different screen from the four-tab record at `/projects/[id]/record`
(D14, LINA-218). M14 is the **home** a party lands on: a four-pillar glance, a
progress line, and the master timeline — the record's tabs stay reachable but
are not this screen.

Two frictions force decisions rather than a straight trace of the pen:

1. **The pen's pillars are `SCHEDULE · BUDGET · SCOPE · SAFETY`**; the shipped
   Ledger derives `cost · time · scope · quality` (`services/ledger/status.mjs`,
   the FR9 derivation). The names must be reconciled.
2. **The pen paints data the ledger does not hold** — a spent figure
   (`€62,400 · 34% of budget`), a green `SAFETY · No incidents`, and per-stage
   day-deltas (`+2d`, `+3d`) against executed dates. Under the no-invented-data
   rule none of these may be faked.

## Decision

### 1. The status contract is re-keyed to `schedule · budget · scope · safety`

`deriveStatus` now returns those four keys. Two are **renames of existing
derivations**, one is unchanged, one is new-and-honest:

| M14 pillar | Source | Change |
|---|---|---|
| `schedule` | was `time` — Σ approved `scheduleImpactDays` | rename only; same fold, same green/amber logic |
| `budget` | was `cost` — current vs baseline, the only quantified pillar | rename only; keeps `baselineCents / currentCents / deltaCents` |
| `scope` | open (proposed) scope-note count | unchanged |
| `safety` | **no backing data** | new; static "not tracked" (below) |

`scope` keeps its green/amber logic. `budget` keeps green (≤ baseline) /
amber (over ≤ threshold%) / red (beyond) — red still only ever occurs on
`budget`, exactly as before the rename.

The `quality` pillar (Σ approved `qualityFlag`) is **removed from the surfaced
panel** — M14 has no quality tile. The proposal payload still carries
`qualityFlag/qualityNote` and change orders still record it; it is simply no
longer folded into a pillar. The `statusInputsFromChain` fold drops
`approvedQualityFlagCount` with it.

### 2. `SAFETY` renders "Not tracked yet", never a green "No incidents"

There is no incidents/safety surface and no safety data anywhere in the ledger.
Emitting the pen's green `No incidents` would be the UI **asserting a safety
record that does not exist** — precisely the invented-datum the no-fixtures rule
forbids, and the most dangerous kind on a build product.

`safety` is therefore a **static** pillar: `{ pillar: 'safety', status: 'none',
label: 'Not tracked yet', icon: 'shield', tracked: false }`. It takes no ledger
input. A new RAG value **`none`** is added (`RagStatus = green|amber|red|none`)
for "a pillar with no signal to report" — muted, not green, and distinct from a
green that would claim all-clear. When an incidents surface exists it becomes a
real derivation and this ADR is superseded for that pillar.

### 3. `BUDGET` shows current-vs-baseline, not a spent meter

The pen's `62,400 spent · 34% of budget` implies **actual-spend tracking** the
product does not have: the ledger holds the baseline and the current contract
budget (baseline + Σ approved change orders), not money actually paid out. The
tile shows the **current contract budget and its net change from baseline** —
the figures the ledger authoritatively owns. A true spend/cost-to-date meter is
a later slice; until then no percent-of-budget is drawn.

### 4. `Week X of Y · On track` derives from the baseline plan, or is omitted

There is no project-level schedule baseline field. The week line is folded
client-side from the **baseline plan's stage planned dates**: `start =
min(plannedStartDate)`, `end = max(plannedEndDate)` across dated stages; `Y =
⌈(end − start)/7⌉`, `X = clamp(⌈(today − start)/7⌉, 1, Y)`. If there is no
accepted baseline, or no stage carries planned dates, **the line is omitted
entirely** — no invented schedule. The "On track / behind" half reads the
`schedule` pillar (the only slip signal the system holds — Σ approved
schedule-impact days), so the header and the pillar can never disagree.

### 5. The master timeline is progress-honest, with no per-stage day-delta

The timeline reads `getRecord().tabs.schedule.lines`, which carry **planned
dates + reported `status`/`percent` only** — there are **no per-stage actual
(executed) dates** anywhere in the schema. So:

- The pen's per-stage day-delta (`+2d`, `+3d`) is **not rendered**: it would
  require an executed-vs-planned date variance the record does not hold.
  Deriving it from `percent` would be inventing dates. It is a deferred slice.
- The `Plan / Actual / Closed` legend is kept and mapped to data the record
  *does* hold: `done` → **Closed** (green, full bar); `in_progress` → **Plan**
  bar (baseline blue) with an **Actual** overlay sized by reported `percent`
  (orange); `not_started` → Plan bar only, muted; `blocked` → Plan bar with a
  blocked marker. "Actual" is therefore **reported progress**, not an executed
  calendar range — the legend's honest meaning here.
- Each stage's **Compare** links to `/projects/[id]/record/[stageId]` (the D15
  line detail — materials behind the price), the existing per-line deep read.
- Timeline bars use the **`--plan-*` STATE ramp** (`--plan-baseline` /
  `--plan-actual` / `--plan-closed`), not the pen's `$builder-orange` PARTY
  tone: per ADR-0009 / the palette split, a commitment's execution state is a
  STATE surface, never a party colour. The tokens carry equal values today; the
  name is the point.

### 6. The bottom nav becomes `Builds · Plan · Docs · More` — shared chrome

The pen's tab bar replaces the R0 `Home · Decisions · Changes · Audit`. This is
**shared chrome on every `/projects/[id]/*` page**, so the change is made once in
`components/chrome.tsx`:

- **Builds** → `/projects` (the portfolio).
- **Plan** → `/projects/[id]` (this M14 home) — the active tab on all
  build-scoped record pages, matching the pen (M14 highlights Plan).
- **Docs** → **dimmed / disabled**: there is no documents surface yet (the pen
  itself dims build-scoped tabs pre-plan on M1). It is not a link until a route
  exists.
- **More** → an overflow menu to the surfaces that lost their own tab —
  **Decisions, Change orders, Audit**, plus the full four-tab **record**.

The pre-pen section-link hub on the old dashboard (the list of `📖 The record /
💷 Budget / 🗓️ Plan / 📋 Decisions / …` rows) is **retired** — its
destinations are reached from the pillars, the timeline, and More.

## Consequences

- **Contract change.** `GET /projects/:id/status` returns `{schedule, budget,
  scope, safety}`. `RagStatus` gains `none`; `PillarKey` becomes the four M14
  keys; `Pillar` gains optional `tracked`. `Pillars` is re-keyed. Consumers:
  `services/ledger/status.mjs`, `pg-ledger.mjs`, `app/src/lib/types.ts`,
  `view.ts`, `icons.tsx`, `PillarPanel.tsx`, the M14 page. The
  `pg-ledger.test.mjs` pillar tests are updated to the new keys.
- **Honest gaps named on the screen, not hidden.** No spent meter, no per-stage
  day-delta, no green safety — each is a deferred slice with a one-line reason in
  the UI copy, the same discipline as `closed_and_verified` on D14.
- **Follow-ups (deferred slices):** (a) an incidents/safety surface that makes
  `safety` a real derivation; (b) executed dates on stages → per-stage schedule
  variance (the day-delta) and a true on-track-vs-baseline; (c) a documents
  surface behind the Docs tab; (d) a cost-to-date / spend meter for BUDGET.
