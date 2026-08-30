# R0 Slice 6 — Plan & Progress analytics delta (LINA-71)

**Owner:** Product Analytics Lead · **Extends:** LINA-28 (`r0-metrics-posthog-spec`)
**Functional source of record:** `docs/product/r0-plan-progress-functional-spec.md`
(§6 is the instrumentation ask; **§8** pins the state machine and rollup the events describe)
**Status:** contract of record for LINA-69 · **Rev 1, 2026-08-28**

This is a *delta*, not a replacement. LINA-28 §2.1 (identity), §2.2
(super-properties), §2.4 (server timestamps) and §3 (PII discipline) apply
unchanged. Everything here is additive: five new events, one new `surface`
value, four new acceptance gates.

**Division of labour (per LINA-71):** I own event names, properties, and shapes.
PM owns that the product questions stay answerable. Data model and emission
mechanics are engineering's — these events flush off the existing analytics
singleton in the LINA-58 composition root. **Do not add a second emission path.**

---

## 1. What this has to answer

| # | Question | Read |
|---|---|---|
| Q1 | Do homeowners engage with the plan? | **A5** — homeowner `plan_timeline_viewed` |
| Q2 | Does the GC actually fill the plan spine in? | **A6** — time-to-first-stage / first-progress |
| Q3 | Is the plan kept alive, or filled once and abandoned? | **A7** — trailing-14d progress liveness |
| Q4 | How often does a stage block, how long does it stay blocked, and does blocking predict a change order? | **A8** — blocked signal read |
| Q5 | Does the plan surface reduce "went sideways" surprises? | **Not measurable in R0** — see §6 |

---

## 2. The event contract

Five events, all `surface: 'plan'` (new value in the §2.2 surface enum), all
server-side, all carrying the unchanged super-properties
`project_id · actor_party_id · actor_role · release_sha · surface` and the
`project` group.

Shape of record lives in `services/analytics/events.mjs` +
`analytics.mjs`; asserted by `services/analytics/analytics.test.mjs`
("Slice 6 plan/progress event contract"). **The code is the contract** — this
document is its rationale.

### 2.1 `plan_document_uploaded`

Actor: GC. Fires on every upload, including replacements (spec AC-P2).

| Property | Type | Notes |
|---|---|---|
| `plan_document_id` | id | |
| `revision` | int | 1-based; `1` is the first upload |
| `is_replacement` | bool | `revision > 1` — the §6 "first vs replacement" split |
| `superseded_document_id` | id \| null | the document this one replaces |
| `content_hash` | string(32) | sha256 **prefix**; ties to AC-P2's content-hash proof |
| `byte_size` | int \| null | |
| `mime_type` | enum \| null | **filename is PII and is never sent** |
| `hours_since_gc_joined` | float \| null | |
| *rollup block* | | see §2.6 |

### 2.2 `stage_added`

Actor: GC. One event per stage.

| Property | Type | Notes |
|---|---|---|
| `stage_id` | id | |
| `position` | int | 1-based plan order |
| `is_first_stage` | bool | gates the time-to-first-stage read |
| `hours_since_gc_joined` | float \| null | **time-to-first-stage** when `is_first_stage` |
| `has_planned_cost` | bool | |
| `planned_cost_cents` | int \| null | **reporting only — never a budget input** (§4) |
| `has_planned_dates` | bool | |
| `planned_duration_days` | int \| null | plan texture; **not** a schedule claim (§4) |
| *rollup block* | | |

### 2.3 `stage_updated`

Actor: GC. §6 asked to separate edit from reorder "if cheap" — it is cheap, so
it is separated via `update_kind`.

| Property | Type | Notes |
|---|---|---|
| `stage_id` | id | |
| `update_kind` | `edit` \| `reorder` \| `edit_reorder` | |
| `position_from` / `position_to` | int \| null | non-null only on a reorder |
| `fields_changed_count` | int | |
| `has_label_change` / `has_note_change` / `has_cost_change` / `has_date_change` | bool | |
| `planned_cost_delta_cents` | int \| null | **not a budget movement** (§4) |
| *rollup block* | | |

**Why three values and not two events.** A single save that both renames and
moves a stage is *one* user action. Emitting two events would double-count edit
frequency and make "how much do GCs churn the plan?" unanswerable. One action,
one event, a third enum value.

**Why `has_*` prefixes.** Not stylistic. The LINA-28 §3 PII guard rejects any
key containing `name`/`note`/`title`/`body` unless it is a `has_*`, `*_len`, or
`*_count`. `has_note_change` passes; `note_changed` would throw at emit time.

### 2.4 `progress_reported` — the centrepiece

Actor: GC. One event per append, including self-transitions (spec §8.1 ●).

| Property | Type | Notes |
|---|---|---|
| `stage_id` | id | |
| `entry_seq` | int | ledger seq — the §8.1 total-ordering tiebreaker (AC-P9) |
| `status_from` | enum | the **derived** status before this append; `not_started` when zero prior entries |
| `status_to` | enum | |
| `transition_kind` | enum | readable label, first-match-wins — **see the warning below** |
| `is_self_transition` | bool | `from == to`; a real append, never a no-op |
| `entered_blocked` | bool | `to == blocked && from != blocked` |
| `exited_blocked` | bool | `from == blocked && to != blocked` |
| `is_reopen` | bool | `from == done && to != done` — rework |
| `is_correction` | bool | `to == not_started` from anything else (the ⚠️ transition) |
| `hours_in_previous_status` | float \| null | dwell in the status being left |
| `advisory_percent` | int \| null | **advisory only — carries no metric** (§4) |
| `has_note` / `note_len` | bool / int | body never ships |
| `is_first_progress_for_stage` | bool | |
| `is_first_progress_for_project` | bool | gates the time-to-first-progress read |
| `hours_since_gc_joined` | float \| null | **time-to-first-progress** when first-for-project |
| *rollup block* | | |

> ⚠️ **Never build a metric on `transition_kind`.** It is a single label with
> precedence, so `done → blocked` is labelled `reopen` and would be missed by a
> `transition_kind = 'block'` filter. The four booleans are the countable
> primitives; they are independent and non-exclusive, so `done → blocked` fires
> **both** `is_reopen` and `entered_blocked`. Blocked-rate = `entered_blocked`.
> Reopen-rate = `is_reopen`. Always.

**Why `from → to` and not just the new value (§6.3).** `blocked` is the
homeowner-intervention signal, and its *meaning* depends on where it came from:
`not_started → blocked` is "we never got started", `done → blocked` is a
re-opened inspection. Same headline word, opposite product implication.

**`hours_in_previous_status` is the blocked-duration answer.** On an event where
`exited_blocked` is true, that number *is* how long the stage sat blocked. This
is why dwell is on the exit event rather than computed from a session-stitch.

**`done` is not terminal** (§8.1). A `done → in_progress` reopen is a genuine,
high-interest rework event and is counted as one, not suppressed as bad data.

### 2.5 `plan_timeline_viewed` — the activation event

Actor: either party. **This is the activation metric for the entire
forward-looking half of R0**, so it gets the most scrutiny.

| Property | Type | Notes |
|---|---|---|
| `has_plan_document` | bool | |
| `is_empty_plan` | bool | true when the GC has added zero stages (§5 empty state) |
| `hours_since_gc_joined` | float \| null | |
| `hours_since_first_stage` | float \| null | the activation clock |
| *rollup block* | | |

- **Server-side, from the plan-timeline read handler.** Not the browser. The
  constraint is explicit in LINA-71 and non-negotiable: a client path would be a
  second emission spine.
- **Homeowner views = this event filtered to `actor_role == 'owner'`.** No
  separate `viewer_role` property — the super-property already carries it, and
  duplicating it invites the two to disagree.
- **`is_empty_plan` must be excluded from activation.** A homeowner who opens
  the timeline and sees "your GC hasn't added the plan yet" has not activated.
  Without this flag the activation number would be inflated by exactly the
  projects where the feature failed.
- **Emission grain:** once per primary timeline read; **not** on sub-resource
  fetches, polls, or partial refreshes. Uniqueness (per-user, per-day) is
  resolved in analysis, not at emission — that keeps the raw event honest and
  lets us change the grain later without a re-instrument.

### 2.6 The rollup block (on every plan event)

`stage_count · done_stage_count · blocked_stage_count · in_progress_stage_count ·
plan_headline · plan_percent_complete`

- **This is a measurement snapshot, not stored state.** Spec §8.3 R4 is
  explicit: the rollup is derived on read and never cached as truth. PostHog is
  not, and must never become, a source of truth for it.
- **Why carry it at all:** it lets the headline be charted over time, and lets
  `entered_blocked` be correlated with a later change order without a join back
  to production. That correlation (Q4) is the single most valuable read in this
  delta.
- `plan_percent_complete` is computed **exactly** per §8.3 R2 — `done` count ÷
  total, floored, **equally weighted**. Never cost-weighted, never
  duration-weighted, advisory percent excluded. `planPercentComplete()` in
  `events.mjs` is the one implementation and the tests pin it.
- `plan_headline` follows §8.3 R1 precedence: `blocked` outranks a finished
  plan. Zero stages ⇒ `null`, never `0`.

---

## 3. Acceptance gates (extends LINA-28's A1–A4)

Pre-declared, per the evidence-gate contract. Targets are **pilot-scale
judgement calls, not forecasts** — pilot N is still open from LINA-28 and
remains non-blocking here (§6).

| Gate | Definition | Window | Target |
|---|---|---|---|
| **A5 — Plan activation** | % of projects with ≥1 stage where the **homeowner** fires ≥1 `plan_timeline_viewed` with `is_empty_plan = false` | 7 days from the project's first `stage_added` | **≥ 60%** |
| **A6 — Plan spine fill** | % of joined GCs firing ≥1 `stage_added` after `gc_joined`; secondary: median `hours_since_gc_joined` on the first-stage event | 72h from `gc_joined` | **≥ 70%**, median **≤ 24h** |
| **A7 — Progress liveness** | % of projects with ≥1 stage having ≥1 `progress_reported` in the trailing window | trailing 14 days | **≥ 50%** |
| **A8 — Blocked signal** | (a) median `hours_in_previous_status` where `exited_blocked`; (b) % of projects with an `entered_blocked` that raise a `change_order_raised` within 14 days | 14 days | **no target — read only** |

**A8 has no target on purpose.** A high blocked-rate is not a product failure;
it may be the product working (the GC is telling the truth on the record). A
*low* blocked-rate is the ambiguous one — either builds are going well or GCs
have stopped reporting bad news, and A7 is the tiebreaker. Setting a target here
would create pressure to under-report exactly the signal the product exists to
capture.

**A5 is the one that decides whether the reframe worked.** If A5 fails while A6
passes, the GC filled the plan in and the homeowner never looked — the
forward-looking half is built but not wanted, and that is a product call for PM
and CEO, not an instrumentation fix.

---

## 4. Guardrails — things that must never become metrics

These are constraints on *analysis*, not just emission. Each maps to a
functional invariant that a careless dashboard would quietly violate.

1. **The advisory per-stage percent carries no funnel, no rollup, no target.**
   Status is the source of truth (§2 Q1). `advisory_percent` is reported for
   texture and may appear in a distribution chart; it may not appear in any gate,
   headline, or completion metric.
2. **Plan rollup percent is equally weighted, always.** Cost-weighting would let
   a stage-cost edit move a headline number and make planned cost feel like
   budget truth (§2 Q2 forbids this). Duration-weighting would manufacture the
   schedule claim the Time pillar refuses (§5). If it is reported anywhere, it is
   reported the R2 way.
3. **Stage planned cost is never a budget number.** `planned_cost_cents` and
   `planned_cost_delta_cents` exist for plan-completeness reads only. No budget,
   cost-pillar, or spend metric may read them. The budget spine stays
   `baseline + Σ approved change orders` (AC-P5); the existing
   `budget_event_written` remains its only analytics source.
4. **`planned_duration_days` is not a schedule baseline.** R0 makes no
   on-track-vs-late claim (§5). No "days late" metric may be derived.
5. **PII discipline unchanged.** Stage labels, notes, filenames, and homeowner
   names never leave the server. Enforced by the §3 guard, which the Slice 6
   tests re-assert against a `stage_name` property.
6. **Never `done`-only.** Reporting completion without the blocked count
   reproduces exactly the "everything's fine until it isn't" failure the product
   exists to prevent.

---

## 5. One contract fix landed with this delta

`assertNoPii` rejected `null` for any `*_cents` property (`Number.isInteger(null)`
is false), so an **optional** planned cost — which spec §2 Q2 makes explicitly
optional — could not be expressed at all. Group-A never hit this because all its
money properties are always present.

Fixed minimally: `null` is now permitted on a `*_cents` key and means *absent*.
Floats are still rejected. **Coercing absent to `0` was rejected as the fix** —
it would misreport an uncosted stage as a free one, which is precisely the class
of silent misreport this guard exists to prevent.

---

## 6. Honest limits

- **No valid A/B test here, and I am not going to pretend otherwise.** Q5 ("does
  the plan surface reduce 'went sideways' surprises?") needs a control arm that
  R0 does not have: one pilot build, one homeowner, one GC, and a feature that
  ships to everyone at once. There is no isolation and no sample size. The
  honest read is **pre/post plus qualitative**, and it should be labelled as
  such in every readout. A dashboard implying a causal claim here would be
  manufactured significance.
- **Pilot N is still open** (carried over from LINA-28, non-blocking). Until it
  is set, every percentage in §3 is a small-N proportion and must be reported
  with its raw numerator and denominator, never as a bare percentage. At pilot
  scale, a single project moves A5 by tens of points.
- **A6 and A7 measure the GC, not the homeowner.** They are leading indicators
  of A5, not substitutes for it. A green A6 with a red A5 is a *failure*, and I
  will report it as one.
- **`hours_in_previous_status` is wall-clock, not working hours.** A stage
  blocked over a weekend reads ~48h longer than the working reality. Fine for
  relative comparison; do not quote it as "the GC took N days".

---

## 7. Handoff

- **Engineering (LINA-69):** the facade methods exist and are tested — wire the
  five call sites in the schedule service and the plan-timeline read handler,
  off the existing composition-root singleton. Rollup counts passed to the facade
  must be the same §8.3 counts the homeowner sees on that read.
- **Designer (LINA-27 delta):** `plan_timeline_viewed` is the activation event;
  the timeline needs to be a distinct, attributable read surface, and the §5
  empty state must be distinguishable from a populated plan (it drives
  `is_empty_plan`).
- **PM (LINA-43):** the §6 functional list is fully covered. No product call is
  outstanding from my side.
- **Me:** dashboards for A5–A8 once the events land in a real environment, plus
  the post-launch readout on this issue.
