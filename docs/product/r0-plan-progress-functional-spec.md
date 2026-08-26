# R0 — Plan & Progress: Functional Detailing (Slice 6)

- **Owner:** Product Manager
- **Status:** Delivered — unblocks LINA-43 (Slice 6 implementation child issues)
- **Date:** 2026-08-26
- **Context:** LINA-26 (R0) · CEO reframe 2026-08-25 (plan approved 22:39) · ADR-0005 · `r0-technical-design.md` §7/§12 (Slice 6)
- **Scope note:** This document is the *what/why* only. Data model, API, infra,
  service boundaries and the ledger discipline are **already decided and owned by
  the Architect + Founding Engineer** (ADR-0005, technical design §3/§6/§7). Where
  this doc names a status value or a rule, it is a **functional requirement to
  satisfy**, not a schema or API instruction. The seam is ready; this fills in the
  behaviour engineering asked the PM to pin down before opening child issues.

---

## 1. Why this exists (the product intent)

R0's trust core answers *"who decided this, when, and how much did it move the
budget?"* — backward-looking. The CEO's reframe adds the **forward-looking** half:
the homeowner opens LinkNMS and sees **the plan of their build progressing stage by
stage against real dates**, staying in **total control of plan · scope · cost ·
quality**.

The ownership split that makes this trustworthy (ADR-0005 §5, unchanged):

- **The GC owns the plan.** The GC enters/uploads the construction plan and reports
  progress. This is theirs to maintain — it is *not* two-sided approved. Forcing
  homeowner approval on every stage edit would make the plan a negotiation instead
  of a status surface, and R0 already has the homeowner's real cost-control lever:
  the change-order approval gate.
- **The homeowner is in control by seeing everything, provably.** Every plan edit
  and progress report is a **ledgered, attributed, time-stamped event** — as
  tamper-evident as a decision or a change order. Control in R0 = total visibility
  + the money gate, not stage-level sign-off.

This document does **not** expand scope beyond ADR-0005. True scheduling
(dependencies, critical path, Gantt) stays out of R0 (LINA-26 cut line). R0 is a
**stage list with dates and progress**, not a scheduler.

---

## 2. Decisions on ADR-0005's three open questions (PM-owned)

ADR-0005 §"Open functional questions" flagged three calls as mine. Here they are,
decided. Each was picked to keep R0 thin and to protect the budget/trust invariant.

### Q1 — Is stage progress a status enum, a percentage, or both?

**Decision: status enum is the source of truth; percent is optional and advisory.**

- **Status is required** and drives everything the homeowner sees and everything we
  measure. Allowed values, exactly:
  `not_started` · `in_progress` · `blocked` · `done`.
- **Percent (0–100) is optional**, only meaningful while status is `in_progress`,
  and is **advisory** — a texture the GC may add, never a computed or authoritative
  number. The homeowner's headline is always the status word, not the percent.
- Rationale: a 4-value status is unambiguous on a phone on-site, is what the
  homeowner actually needs ("is foundation done or not?"), and gives analytics a
  clean domain event. A raw percentage invites false precision and arguments R0
  can't adjudicate. Keeping percent optional/advisory means we never have to
  reconcile "70% but status says done."

**`blocked` is deliberately first-class** (not folded into a note): "the GC says
this stage is blocked, on this date" is exactly the attributable, time-stamped claim
the product exists to make trustworthy, and it's the single most important signal
for a homeowner deciding whether to intervene.

### Q2 — Must stage planned costs reconcile to the baseline, or are they free-form?

**Decision: free-form, with a read-only "allocated vs baseline" hint. No enforcement.**

- The GC enters planned cost per stage freely. The system **never blocks or forces**
  stage costs to sum to the baseline.
- We show a **read-only reconciliation hint** on the plan surface:
  *"Plan allocates $X of the $Y baseline"* (and the delta), clearly labelled as an
  informational allocation.
- **Hard invariant (ADR-0005 §3, restated as a functional rule):** stage planned
  cost is **never** an input to the authoritative budget. The Cost pillar and the
  current-budget number stay `baseline + Σ approved change orders`, full stop. A
  stage cost changing must be **incapable** of moving the budget total.
- Rationale: at R0 (one homeowner, one GC, one build) planners are rough and change
  often; enforcement would create friction with zero trust benefit. The hint gives
  the homeowner a sense of "is the plan even costed to my budget?" without inventing
  a second source of budget truth — which is the one thing we must never do.

### Q3 — Does the homeowner acknowledge/comment on progress in R0, or view-only?

**Decision: view-only for progress. If the homeowner needs to respond, they use the
tools R0 already has** — a **decision-log entry** (to put a concern on the record,
attributed and permanent) or a **change order** (if it moves money/scope). No new
acknowledge/comment primitive is added in Slice 6.

- Rationale: an "acknowledge" checkbox with no consequence is trust theatre; a
  comment thread is a new surface, new moderation, new scope. R0's whole thesis is
  that the record already carries every attributable statement. Routing homeowner
  response through the decision log keeps **one** tamper-evident history instead of
  two, and keeps Slice 6 genuinely thin.
- **Follow-up flagged (not R0):** homeowner acknowledgement of a stage as a
  first-class, ledgered event is a natural R1 candidate — captured in §7, not built
  now.

---

## 3. Functional requirements (what users must be able to do)

Numbered as **FR-P** (Plan) to extend LINA-26's FR1–FR9 without renumbering them.
Actor names match ADR-0004/0005: **GC** = counterparty, **Homeowner** = owner.

**FR-P1 — Enter the plan as stages.** The GC can add construction stages, each with:
a **name** (required), an **order/position** in the plan (required), and optional
**scope note**, **planned start date**, **planned end date**, and **planned cost**.
The GC can reorder stages and edit any stage field later.

**FR-P2 — Upload the plan document.** The GC can upload the source construction plan
(PDF/image) as the plan-of-record. The homeowner can **download** it, and its
**integrity is verifiable** (content-hash anchored in the ledger — the file that was
the plan of record at a point in time is provable). Uploading a new file supersedes
the prior plan-of-record; prior versions are never silently lost from the record.

**FR-P3 — Report progress, append-only.** The GC can report progress on any stage: a
**status** (`not_started`/`in_progress`/`blocked`/`done`), an optional **percent**
(only while `in_progress`), and an optional **note**. Each report is a **new,
attributed, time-stamped entry** — the current status is the latest report; **earlier
reports are never overwritten or deleted** (same discipline as decision revisions).

**FR-P4 — See the plan as a timeline.** The homeowner (and the GC) can see the plan
as an **ordered stage timeline**: each stage's name, dates, scope note, planned-cost
allocation, and **current progress** (status + optional %). The timeline reads
top-to-bottom in plan order and is legible on a phone.

**FR-P5 — Trust every plan/progress statement.** Every plan/progress action — plan
upload, stage add/update, progress report — appears in the **audit view** as a
ledgered event showing **who did it and when**, alongside decisions and change
orders, and is covered by the same **chain-verify** integrity guarantee.

**FR-P6 — Keep planned cost visibly separate from the real budget.** The plan surface
shows planned cost as an **allocation**, visually and labelled distinct from the
authoritative current budget. The "allocated vs baseline" hint (Q2) is read-only.
Nothing on the plan surface can change the budget total.

**FR-P7 — Homeowner control lever is unchanged and adjacent.** From the plan, if the
homeowner disagrees with a direction, the path is the existing one: raise/record it
via **decision log** or **change order**. The plan surface should make that path
reachable, but the plan itself stays GC-owned and view-only for the homeowner.

---

## 4. Acceptance criteria (demonstrably true for a homeowner + one GC)

A slice is done when all of these hold end-to-end, with immutability provably holding
(mirrors LINA-26's acceptance style, extends it):

- **AC-P1** GC adds ≥3 ordered stages with dates and planned costs; homeowner sees
  them in order on the plan timeline. GC reorders a stage; the new order persists.
- **AC-P2** GC uploads a plan PDF; homeowner downloads the exact bytes; the audit
  view proves *which* file was plan-of-record and when (content hash matches). GC
  uploads a replacement; both the supersede and the original remain in the record.
- **AC-P3** GC reports a stage `in_progress` (60%), later `blocked` (note), later
  `done`. Homeowner sees `done` as current; the full progression
  (`in_progress`→`blocked`→`done`) with authors + timestamps is retrievable and
  **no earlier report was overwritten**.
- **AC-P4** Every action in AC-P1…P3 appears in the audit view with correct actor +
  timestamp, and **chain-verify returns verified** across decisions, change orders,
  **and** plan/progress events together.
- **AC-P5 (the invariant test — must pass):** set stage planned costs summing to
  **more** than the baseline; the current budget number and the Cost pillar are
  **unchanged**. Only an approved change order ever moves the budget. The
  "allocated vs baseline" hint reflects the over-allocation as information only.
- **AC-P6** Homeowner cannot add/edit stages, upload the plan, or report progress
  (authorization denies GC-only actions for the owner). GC cannot approve their own
  change order (unchanged FR4 — regression check that Slice 6 didn't loosen it).
- **AC-P7** Status is never colour-only on the timeline: each stage's status carries
  a **label + icon**, and `blocked` is visually distinct (FR9 accessibility carried
  into the plan surface).

---

## 5. Edge cases & rules to pin behaviour

- **Empty plan.** Before the GC enters any stage, the homeowner's plan surface shows
  an explicit *"Your GC hasn't added the construction plan yet"* empty state — never
  a blank or a fake stage.
- **Percent without in_progress.** Percent is ignored/hidden unless status is
  `in_progress`. Reporting `done` clears any lingering percent from the headline.
- **`done` then re-opened.** The GC may report a stage back to `in_progress`/`blocked`
  after `done` (rework happens). This is just another append; the history shows the
  reopen, attributed. No special lock — the record tells the truth either way.
- **Stage deletion.** In R0, stages are **not hard-deleted**; a mistaken stage is
  handled by editing it (rename/note) — deletion would fight the append-only,
  provable-record promise. (If a true "remove from plan" is needed, it is a ledgered
  event, not a silent row drop — engineering's call on mechanism; functionally it
  must remain in the audit trail.)
- **Planned dates are not a baseline claim.** Dates on stages are the GC's plan; R0
  makes **no** on-track-vs-baseline schedule claim (consistent with the Time pillar
  rule, §5 of the technical design — Time only reflects Σ schedule-impact days on
  approved COs). The timeline shows planned dates and progress; it does not compute
  "you are N days late."
- **Progress on a non-started plan-document.** Progress reporting requires the stage
  to exist; it does not require a plan document to be uploaded (a GC may build the
  stage list without the source PDF). Both paths are independently valid.

---

## 6. Instrumentation ask (analytics — extends LINA-28)

The LINA-28 metrics/PostHog spec covers the trust core. Slice 6 adds a small,
consistent set of domain events for the plan/progress spine (event **names/shape are
analytics + engineering's call**; this is the functional list of *what must be
measurable*):

- Plan document uploaded (first upload vs replacement).
- Stage added / stage updated.
- Progress reported, carrying the **status** transition (esp. `→ blocked` and
  `→ done`) — `blocked` is the highest-signal homeowner-intervention event.
- Homeowner viewed the plan timeline (activation of the forward-looking half).
- Time-to-first-stage and time-to-first-progress from GC join (does the plan spine
  actually get used?).

These let us answer whether the reframe worked: **do homeowners engage with the
plan, and does the plan surface reduce "went sideways" surprises?** Analytics owns
the final event contract; PM owns that these questions are answerable.

---

## 7. Explicitly out of Slice 6 / R0 (guardrails against scope creep)

- Homeowner acknowledgement of progress as a first-class ledgered event → **R1
  candidate** (Q3 follow-up).
- Stage dependencies, critical path, Gantt, auto-computed "days late" → out (LINA-26
  cut line; ADR-0005 "revisit when").
- Multi-party plans (subs, inspectors, site manager each with plan roles) → future
  vision (LINA-26 "where this is heading"); R0 is GC-authored, single counterparty.
- Enforced budget reconciliation / stage-cost approval workflow → out (Q2); the money
  gate stays the change order.
- Photo/evidence attachments on progress reports → out of R0.

---

## 8. Handoff

This completes the PM functional detailing that Slice 6 was blocked on. The design
seam (ADR-0005, technical design §3/§6/§7) is unchanged and sufficient — nothing here
requires a data-model or API change; the three defaults ADR-0005 assumed are now
**confirmed decisions** (status enum + optional advisory %, free-form planned cost
with a read-only hint, view-only progress with decision-log as the response path).

**Next owner: Founding Engineer** — open the Slice 6 implementation child issues
against the existing seam. Designer (LINA-27) and Analytics (LINA-28) get a light
delta brief for the plan-timeline surface and the §6 events; those are follow-ups,
not blockers on opening the build issues.
