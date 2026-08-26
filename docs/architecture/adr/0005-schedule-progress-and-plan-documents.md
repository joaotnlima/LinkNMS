# ADR-0005 — Schedule/Progress service & plan documents

- **Status:** Proposed (awaiting CEO approval)
- **Date:** 2026-08-25
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-26 (R0) — scope expansion (CEO, 2026-08-25)

## Context

The CEO expanded R0 today: the GC **enters or uploads the construction plan**,
and the homeowner sees a **timeline of stages** — each with dates, scope, cost,
and progress. This is the "homeowner in total control of plan · scope · cost ·
quality" spine. It adds two new needs the first four ADRs did not cover:

1. A place to model **stages** and their **progress**, owned by the GC and
   viewed by the homeowner.
2. **Object storage** for an uploaded plan document (PDF/image), which the four
   existing services do not touch.

Two integrity risks come with it, and this ADR exists to contain them:

- **Budget corruption.** Stage-level cost must *not* silently become a second
  source of budget truth. The budget invariant (ADR-0002 §, ADR-0003 Ledger &
  Budget) stays: `current budget = baseline + Σ approved change orders`. Stage
  cost is a **planned allocation**, informational, never summed into the
  authoritative total.
- **Untrustworthy progress claims.** "GC marked foundation complete on the 12th"
  is exactly the kind of attributable, time-stamped claim the product promises
  to make tamper-evident. Progress cannot be a mutable field nobody can audit.

## Decision

### 1. A fifth bounded service: **Schedule & Progress**

Following ADR-0003's pattern — a module with a typed interface, owning its own
tables, sharing the one Postgres instance, never read across ownership lines.

| Service | Owns (tables) | Responsibility | Must not |
|---------|---------------|----------------|----------|
| **Schedule & Progress** | (projections) `stage`, `stage_progress`, `plan_document` | The construction plan: stages (order, dates, scope note, **planned** cost), progress updates, plan-document metadata | Compute or move the authoritative budget; make authorization decisions |

### 2. Progress and plan uploads are **ledgered events**, like everything else

The service owns `stage`/`stage_progress`/`plan_document` as **projections**;
every mutation appends an `audit_event` through Ledger & Budget in the **same DB
transaction** (identical rule to Decision Log and Change Order, ADR-0003). New
event types: `plan_document_uploaded`, `stage_added`, `stage_updated`,
`stage_progress_recorded`. Result: "who changed the plan / who reported this
progress, and when" is attributable and hash-chained, not a bare column write.

### 3. Stage cost is a **planned allocation**, structurally isolated from budget

- `stage.planned_cost_cents` is informational. It is **never** an input to the
  budget total. The four-pillar **Cost** signal stays `baseline + Σ approved
  COs` (ADR-0002, unchanged).
- We *may* surface "plan allocates X of the Y baseline" as a read-only
  reconciliation view, but the authoritative number is always the ledger's.
- No `budget_event` is ever written by Schedule & Progress. Only Change Order
  approval moves money (ADR-0003).

### 4. Plan documents: **Vercel Blob**, hash anchored in the ledger

- The uploaded file lives in **Vercel Blob** (FE cost doc — $0 at R0 volume).
- `plan_document` stores metadata + a **SHA-256 content hash** of the bytes.
- Upload appends a `plan_document_uploaded` event carrying that content hash, so
  the ledger proves *which* file was the plan of record at that time even though
  the bytes live in blob storage. Tamper-evidence extends to the document.

### 5. Permissions (ADR-0004 extension)

- **GC (counterparty)** authors the plan: create/upload plan document, add and
  update stages, record progress.
- **Homeowner (owner)** views the plan and progress; both parties read.
- This is **GC-authored, not two-sided-approved** (unlike change orders). The
  homeowner's control lever over cost stays the change-order approval gate; the
  plan is the GC's to maintain, fully visible and fully audited.

## Open functional questions (PM owns — flagged, not assumed)

These are *what/why* calls for the Product Manager; the design above picks a safe
default for each but must not be treated as settled scope:

1. Is stage progress a **status enum** (not-started/in-progress/blocked/done) or
   a **percentage**, or both? (Default assumed: status enum + optional %.)
2. Must stage planned costs **reconcile to baseline**, or are they free-form?
   (Default: free-form + a read-only "allocated vs baseline" hint, no enforcement.)
3. Does the homeowner get any **acknowledge/comment** on progress in R0, or
   view-only? (Default: view-only; comments are a decision-log entry if needed.)

## Consequences

- **Positive:** the new scope reuses the exact ledger/transaction discipline the
  trust core already has — progress and plan changes are as auditable as
  decisions and change orders. The budget invariant is structurally protected.
  Extraction path is identical to the other four services.
- **Negative / debt:** a fifth service and an external blob dependency add
  surface. Blob is off the relational transaction, so the ledger's content-hash
  is what ties a file to a point in time — we accept eventual cleanup of orphaned
  blobs (uploaded-but-never-committed) via a sweep, out of scope for R0.
- **Revisit when:** the plan needs true scheduling (dependencies, critical path)
  — explicitly out of R0 scope (LINA-26 cut line: "Scheduling / Gantt"). R0 is a
  stage list with dates and progress, not a scheduler.
