# Slice — Direct plan authoring ("Build the plan here") — frozen contract

- Issue: LINA-228
- ADR: 0017-direct-plan-authoring.md
- Owner: Full-Stack Architect
- Status: Frozen (v1)

The FE and BE build against this. It mirrors the B1 import `:confirm` write and
feeds the B2 D11–D13 proposal surface unchanged.

## §0 — Shape

One new write, no reads of its own (the authored plan is read back through the
existing `GET /projects/:id/plan`, which returns `{ baseline, current, history }`).

```
POST /projects/:projectId/plan-versions:author        (JSON body)
```

GC-or-owner (either project party) — `PROPOSE_PLAN` (ADR-0004). The acting party
is derived from the session server-side, never the body (ADR-0004). Both parties
may author; the *other* party reviews (`REVIEW_PLAN` denies the proposer).

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

## §2 — Behaviour (one transaction)

Exactly the import `:confirm` spine, minus the parser and the import header:

1. Authorise `PROPOSE_PLAN` on `projectId`.
2. Validate the tree (§1). Flatten to pre-order, parents before children.
3. If an open (`proposed`) version already exists for the project →
   `409 open_plan_exists` (withdraw it first). This is checked in-txn and also
   enforced by the `plan_version_one_open_per_project` unique index; a racing
   insert that trips it maps to the same `409`.
4. In ONE transaction:
   - `ledger.append` a `plan_proposed` event: payload
     `{ planVersionId, versionNo, sourceImportId: null, supersedesVersionId: null, stageCount }`.
   - `insertPlanVersion` (v1, `proposed`, `source_import_id = null`,
     `supersedes_version_id = null`, `proposed_by_party_id = actor`).
   - `insertPlanAcceptance` — the author's `'proposed'` stamp, `audit_event_id`
     = the `plan_proposed` event id.
   - `insertStage` for each node, parents before children, positions appended
     after any existing stages (`maxStagePosition + i + 1`), each bound to the
     new `plan_version_id`. `import_id = null`, `source_row_ref = null`,
     `scope_note = null`.
   - No `stage_dependency` rows (authoring has no dependency UI in v1).

## §3 — Response

`201 Created`:

```jsonc
{
  "planVersionId": "uuid",
  "versionNo": 1,
  "status": "proposed",
  "stageCount": 12,
  "rootCount": 3,
  "auditEventId": "uuid"   // the plan_proposed event — links to the audit trail
}
```

Errors use the platform envelope `{ error: { code, message, details? } }`:
`401 unauthenticated`, `403 forbidden`, `400 empty_plan|invalid_name|too_deep|
invalid_plannedStartDate|invalid_plannedEndDate|invalid_cost|invalid_stages`,
`409 open_plan_exists`.

## §4 — FE

- Route: `/projects/:id/plan/build`. Reachable from the live *Route 2* card on
  `/projects/:id/plan` (D7). GC and owner both see it (either may author).
- The editor seeds the standard skeleton (see `app/src/lib/plan-authoring.ts`),
  supports add / rename / reorder / remove of phases (actions) and tasks
  (sub-actions) and optional start/finish dates, shows a "Draft · not committed"
  status, and a primary **Create the plan** that POSTs the tree and redirects to
  `/projects/:id/plan` (the proposal now renders in `PlanBaseline`).
- On `409 open_plan_exists` the editor tells the author a proposal is already
  open and links to the plan.
- The actor is never sent; authorisation is the server's. Affordances shape
  buttons only.

## §5 — Out of scope (ADR-0017 §5)

Drag-to-schedule, auto-schedule, task drawer, dependencies UI, per-task
owner/assignee, milestone/bug types, third-level sub-tasks, paste-to-generate.
Deferred follow-ups, not mocked as dead controls.
