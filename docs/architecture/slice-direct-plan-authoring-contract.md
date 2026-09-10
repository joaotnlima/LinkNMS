# Slice — Direct plan authoring ("Build the plan here") — frozen contract

- Issue: LINA-228, **LINA-230** (draft-not-proposal)
- ADR: 0017-direct-plan-authoring.md (+ LINA-230 annex)
- Owner: Full-Stack Architect
- Status: Frozen (v2 — authoring is private drafting; proposal is a second act)

The FE and BE build against this. It mirrors the B1 import `:confirm` write and
feeds the B2 D11–D13 proposal surface unchanged.

> **v2 change (LINA-230).** Authoring now saves a private **draft**, NOT a
> proposal. `:author` writes `status='draft'` (event `plan_drafted`), invisible to
> the other party; a new `:propose` endpoint ("Send for approval") flips it to
> `proposed`. See the ADR-0017 LINA-230 annex for the rationale and the three
> model calls (no `drafted` stamp; `version_no` assigned at propose; in-place
> draft replacement via a guarded DELETE).

## §0 — Shape

Two writes, no reads of their own (the authored plan is read back through the
existing `GET /projects/:id/plan`; a draft appears as `current` to its author
ONLY, never to the other party and never in `history`).

```
POST /projects/:projectId/plan-versions:author          (JSON body) → save a draft
POST /projects/:projectId/plan-versions/{id}:propose     (no body)   → send for approval
```

GC-or-owner (either project party) — `PROPOSE_PLAN` (ADR-0004). The acting party
is derived from the session server-side, never the body (ADR-0004). Both parties
may author; `:propose` is the drafter's own act (actor must equal the drafter);
the *other* party reviews (`REVIEW_PLAN` denies the proposer).

## §1 — Request body

```jsonc
{
  "stages": [                         // required, non-empty array of ACTION nodes
    {
      "name": "1 · Pre-Construction", // required, non-empty, trimmed, ≤ 200 chars
      "trade": null,                  // optional free-form label, ≤ 120 chars or null
      "plannedStartDate": null,       // optional "YYYY-MM-DD" or null
      "plannedEndDate": null,         // optional "YYYY-MM-DD" or null
      "plannedCostCents": null,       // optional integer cents or null
      "children": [                   // optional SUB-ACTION nodes (one level only)
        {
          "name": "1.1 Planning & Feasibility",
          "trade": null,
          "plannedStartDate": null,
          "plannedEndDate": null,
          "plannedCostCents": null
          // sub-actions have NO children — the WBS is exactly two levels
        }
      ]
    }
  ]
}
```

Rules:
- `stages` must be a non-empty array. Empty → `400 empty_plan`.
- Every node needs a non-empty `name` (trimmed, ≤ 200) → else `400 invalid_name`.
- Two levels only: a node inside `children` may not itself carry `children` →
  `400 too_deep`. (The model's self-ref FK permits deeper; this slice does not.)
- Dates must match `^\d{4}-\d{2}-\d{2}$` or be `null` → else `400 invalid_plannedStartDate`/`invalid_plannedEndDate`.
- `plannedCostCents` must be an integer or `null` → else `400 invalid_cost`.
- No `id`, `position`, `parentId`, `importId` accepted in the body — the server
  assigns ids and positions. Unknown keys are ignored.

The skeleton the FE seeds (phase = action, task = sub-action, names only, no
dates) is just a pre-filled instance of this body; the server has no skeleton of
its own.

## §2 — `:author` behaviour (one transaction) — SAVE A DRAFT

Authoring saves the author's **private draft**, not a proposal:

1. Authorise `PROPOSE_PLAN` on `projectId`.
2. Validate the tree (§1). Flatten to pre-order, parents before children.
3. If an open (`proposed`) version already exists → `409 open_plan_exists`
   (can't draft while a proposal is live; withdraw it first). If a draft exists
   owned by a *different* party → `409 draft_exists`.
4. In ONE transaction:
   - `ledger.append` a **`plan_drafted`** event: payload
     `{ planVersionId, sourceImportId: null, stageCount }` (NO `versionNo` — a
     draft is unnumbered).
   - **First save (no existing draft):** `insertPlanVersion` with
     `status='draft'`, `version_no = NULL`, `source_import_id = null`,
     `supersedes_version_id = null`, `proposed_by_party_id = actor`,
     `frozen_at = null`. **NO** `plan_acceptance` stamp (see the ADR annex — the
     authorship `'proposed'` stamp is written at `:propose`, not here).
   - **Re-save (draft exists, same author):** `deleteStagesByPlanVersion` then
     re-insert — the draft's stages are replaced in place (guarded DELETE; only a
     draft's stages are deletable). The version row is untouched.
   - `insertStage` for each node, parents before children, positions appended
     after any existing stages (`maxStagePosition + i + 1`), each bound to the
     draft's `plan_version_id`. `import_id = null`, `source_row_ref = null`,
     `scope_note = null`.

The draft is **invisible** to the other party: `getPlan` returns it as `current`
only when `actorPartyId == proposed_by_party_id`, and never in `history`.

## §2a — `:propose` behaviour (one transaction) — SEND FOR APPROVAL

The explicit second act. `draft → proposed`:

1. Load the version (404 if missing). Authorise `PROPOSE_PLAN`; actor MUST equal
   `proposed_by_party_id` → else `403 forbidden`.
2. If `status != 'draft'` → `409 not_draft`.
3. In ONE transaction:
   - `versionNo = nextPlanVersionNo(projectId)` (assigned NOW, not at draft time).
   - `ledger.append` a `plan_proposed` event: payload
     `{ planVersionId, versionNo, sourceImportId: null, supersedesVersionId: null, stageCount }`.
   - `updatePlanVersionStatus` → `status='proposed'`, `version_no = versionNo`.
   - `insertPlanAcceptance` — the author's `'proposed'` stamp, `audit_event_id`
     = the `plan_proposed` event id (the first of the two stamps that freeze a
     baseline; the reviewer's `accept` is the second, unchanged).
   - A racing open proposal trips `plan_version_one_open_per_project` →
     `409 open_plan_exists`.

## §3 — Responses

`:author` → `201 Created`:

```jsonc
{
  "planVersionId": "uuid",
  "versionNo": null,       // a draft is unnumbered until proposed
  "status": "draft",
  "stageCount": 12,
  "rootCount": 3,
  "auditEventId": "uuid"   // the plan_drafted event — links to the audit trail
}
```

`:propose` → `200 OK`:

```jsonc
{
  "planVersionId": "uuid",
  "versionNo": 1,
  "status": "proposed",
  "auditEventId": "uuid"   // the plan_proposed event
}
```

Errors use the platform envelope `{ error: { code, message, details? } }`:
`401 unauthenticated`, `403 forbidden`, `400 empty_plan|invalid_name|too_deep|
invalid_plannedStartDate|invalid_plannedEndDate|invalid_cost|invalid_stages`,
`409 open_plan_exists|draft_exists|not_draft`, `404 not_found` (`:propose`).

## §4 — FE

- Route: `/projects/:id/plan/build`. Reachable from the live *Route 2* card on
  `/projects/:id/plan` (D7), and from **Keep editing** on a saved draft. GC and
  owner both see it (either may author).
- The editor seeds the standard skeleton (see `app/src/lib/plan-authoring.ts`) or
  **resumes an existing draft** (hydrated from `getPlan`), supports add / rename /
  reorder / remove of phases (actions) and tasks (sub-actions) and optional
  start/finish dates, shows a "Draft — only you can see it" status, and a primary
  **Save plan** that POSTs the tree and redirects to `/projects/:id/plan?drafted=…`.
- On the plan page a saved draft shows (to its author only) a "Saved as a draft"
  banner and two actions: **Keep editing** (→ `/plan/build`) and **Send for
  approval** (`:propose`). The authorship stamp appears only after propose.
- On `409 open_plan_exists`/`draft_exists` the editor sends the author to the live
  plan rather than re-clicking a button that will keep 409-ing.
- The actor is never sent; authorisation is the server's. Affordances shape
  buttons only.

## §5 — Out of scope (ADR-0017 §5)

Drag-to-schedule, auto-schedule, task drawer, dependencies UI, per-task
owner/assignee, milestone/bug types, third-level sub-tasks, paste-to-generate.
Deferred follow-ups, not mocked as dead controls.
