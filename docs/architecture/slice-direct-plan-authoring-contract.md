# Slice — Direct plan authoring ("Build the plan here") — frozen contract

- Issue: LINA-228, **LINA-230** (draft-not-proposal), **LINA-233** (dependencies), **LINA-235** (assignee), **LINA-251** (typed dependencies)
- ADR: 0017-direct-plan-authoring.md (+ LINA-230 annex, LINA-233 annex 2, LINA-235 annex 3), **0020-typed-plan-dependencies.md**
- Owner: Full-Stack Architect
- Status: Frozen (v5 — typed dependencies)

The FE and BE build against this. It mirrors the B1 import `:confirm` write and
feeds the B2 D11–D13 proposal surface unchanged.

> **v2 change (LINA-230).** Authoring now saves a private **draft**, NOT a
> proposal. `:author` writes `status='draft'` (event `plan_drafted`), invisible to
> the other party; a new `:propose` endpoint ("Send for approval") flips it to
> `proposed`. See the ADR-0017 LINA-230 annex for the rationale and the three
> model calls (no `drafted` stamp; `version_no` assigned at propose; in-place
> draft replacement via a guarded DELETE).

> **v3 change (LINA-233).** Predecessor links ("depends on") are authored by hand
> on the same draft save. Each node may carry an author-local `key` and a
> `dependsOn` list of predecessor keys (any distinct stage is a valid target,
> cross-level allowed). The keys are resolved to server stage ids **in the same
> transaction** as the stages and the single `plan_drafted` event — a dependency
> edit is part of "the draft saved at T", never a separate event/endpoint. The
> graph is validated **totally, server-side, before any write** (self/unknown
> deps → 400, cycles → 409). `getPlan` returns each stage's resolved `dependsOn`
> (server stage ids) for the FE to render predecessor chips. Persistence is
> guarded: a frozen/terminal version's dependency rows can never be deleted
> (migration 0007, mirroring the stage guard from 0005).

> **v5 change (LINA-251, ADR-0020).** Dependencies are now **typed**:
> `starts_after` (finish-to-start, the previous implicit semantics),
> `starts_with` (start-to-start), `ends_with` (finish-to-finish). Each
> `dependsOn` entry may be a bare key (compat alias for
> `{ key, type: "starts_after" }`) or `{ "key": "...", "type": "..." }`.
> Unknown type → `400 invalid_dependency_type`; duplicate target within one
> stage → `400 duplicate_dependency`; one typed link per ordered pair (PK
> unchanged). `getPlan` additionally emits
> `dependencies: [{ on: <stageId>, type }]` per node; legacy `dependsOn`
> (ids only) stays dual-emitted until the FE consumes `dependencies` in prod.
> Cycle rule is type-blind (single DAG). Storage: migration 0010 adds
> `dep_type` with default `starts_after`. See ADR-0020 for Gantt connector
> anchoring and auto-schedule semantics.

> **v4 change (LINA-235).** Each stage gains an optional **assignee** — a
> reference to a party/membership on the project (bare uuid, not a free-form
> name) — persisted in `schedule.stage.assignee_party_id` (migration 0009).
> `:author` accepts `assigneePartyId` per node, validated server-side against the
> project membership (identity port `roleOf`); an unknown party is rejected with
> `400 unknown_assignee`. The draft's assignee is read back through `getPlan` as
> `assigneePartyId` per stage; the FE resolves display names and avatar initials
> from its already-loaded project members directory. Assignment rides the same
> tamper-evident `:author` write as every other stage field — one `plan_drafted`
> ledger event per save. The `trade` label (free-form, migration 0002) is surfaced
> in `:author` and `getPlan` as `trade` per stage.

## §0 — Shape

Two writes, no reads of their own (the authored plan is read back through the
existing `GET /projects/:id/plan`; a draft appears as `current` to its author
ONLY, never to the other party and never in `history`).

```
POST /projects/:projectId/plan-versions:author          (JSON body) → save a draft
POST /projects/:projectId/plan-versions/{id}:propose     (no body)   → send for approval
```

The read shape is unchanged except that every node now carries `dependsOn`: the
resolved predecessor **stage ids** (empty array when none), and — since LINA-235 —
the `trade` label and `assigneePartyId` (the party id assigned to the stage, or
null), so the FE can render predecessor chips and owner avatars/initials without a
second request (avatar/initials resolve from the project members directory).

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
      "key": "pre-construction",      // optional, author-local id; unique per payload,
                                      // ≤ 200 chars; used ONLY to resolve dependsOn,
                                      // never persisted
      "dependsOn": [],               // optional array of predecessor KEYS (any stage,
                                      // any level); empty / omitted = no predecessors
      "trade": null,                  // optional free-form label, ≤ 120 chars or null
      "assigneePartyId": null,         // optional party id on the project (uuid string),
                                      // validated server-side against project members;
                                      // null = unassigned
      "plannedStartDate": null,       // optional "YYYY-MM-DD" or null
      "plannedEndDate": null,         // optional "YYYY-MM-DD" or null
      "plannedCostCents": null,       // optional integer cents or null
      "children": [                   // optional SUB-ACTION nodes (one level only)
        {
          "name": "1.1 Planning & Feasibility",
          "key": "p&f",               // sub-actions may also carry key + dependsOn
          "dependsOn": ["phase-a"],
          "trade": null,
          "assigneePartyId": null,
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
- `assigneePartyId` (optional): a non-empty string ≤ 200 chars naming a party that
  is a member of the project. Validated server-side against the identity
  membership — a party that is not on the project → `400 unknown_assignee`.
  Blank / non-string → `400 invalid_assignee`. Null / omitted = unassigned.
- `key` (optional): non-empty string ≤ 200 chars, unique across the payload →
  `400 duplicate_key` on a repeat. Keys are author-local only — resolved to server
  stage ids in-transaction and never persisted.
- `dependsOn` (optional): an array of keys naming this node's **predecessors**
  (any distinct stage — root or sub-action — is a valid target; there is no
  parent/level constraint). Validated server-side **before any write**:
  - a node may not list its own key → `400 self_dependency`;
  - a key that matches no node in the payload → `400 unknown_dependency`
    (`details.key` names it, `details.stage` names the dependent);
  - a cycle in the resolved graph (A after B, B after A) → `409 dependency_cycle`
    with `details.stages` naming every stage on the cycle, in cycle order, so the
    FE can highlight them.
- No `id`, `position`, `parentId`, `importId` accepted in the body — the server
  assigns ids and positions. Unknown keys are ignored.

The skeleton the FE seeds (phase = action, task = sub-action, names only, no
dates) is just a pre-filled instance of this body; the server has no skeleton of
its own.

## §2 — `:author` behaviour (one transaction) — SAVE A DRAFT

Authoring saves the author's **private draft**, not a proposal:

1. Authorise `PROPOSE_PLAN` on `projectId`.
2. Validate the tree (§1). Flatten to pre-order, parents before children.
3. Resolve + validate the dependency graph (§1) — **totally, before any write**:
   self/unknown/duplicate → 400; cycle (DFS back-edge) → 409 with the cycle named.
   The whole graph is revalidated on every save, so a draft can never be saved in
   a cyclic state.
4. Validate every `assigneePartyId` (if present) is a party/membership on the
   project (identity port `roleOf`) → else `400 unknown_assignee` (LINA-235).
5. If an open (`proposed`) version already exists → `409 open_plan_exists`
   (can't draft while a proposal is live; withdraw it first). If a draft exists
   owned by a *different* party → `409 draft_exists`.
6. In ONE transaction:
   - `ledger.append` a **`plan_drafted`** event: payload
     `{ planVersionId, sourceImportId: null, stageCount }` (NO `versionNo` — a
     draft is unnumbered; NO dependency payload — the links are part of the
     draft's rows, not a separate event).
   - **First save (no existing draft):** `insertPlanVersion` with
     `status='draft'`, `version_no = NULL`, `source_import_id = null`,
     `supersedes_version_id = null`, `proposed_by_party_id = actor`,
     `frozen_at = null`. **NO** `plan_acceptance` stamp (see the ADR annex — the
     authorship `'proposed'` stamp is written at `:propose`, not here).
   - **Re-save (draft exists, same author):**
     `deleteStageDependenciesByPlanVersion` **then** `deleteStagesByPlanVersion`
     then re-insert — the draft's stages AND its predecessor graph are replaced
     in place (both guarded DELETEs; only a draft's rows are deletable). The
     dependency delete runs first: the stage DELETE would otherwise fail on the
     FK `stage_dependency.stage_id → stage.id`. The version row is untouched.
- `insertStage` for each node, parents before children, positions appended
     after any existing stages (`maxStagePosition + i + 1`), each bound to the
     draft's `plan_version_id`. `import_id = null`, `source_row_ref = null`,
     `scope_note = null`. `trade` and `assignee_party_id` are carried through
     from the payload (nullable; null = unassigned / no tag).
   - `insertStageDependency` for each resolved predecessor — the keys were
     resolved to the fresh stage ids HERE, in the same transaction as the stages
     and the single `plan_drafted` event. Cross-version edges are impossible for
     authored drafts (both endpoints are in this version).

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
invalid_plannedStartDate|invalid_plannedEndDate|invalid_cost|invalid_stages|
invalid_assignee|unknown_assignee|
duplicate_key|self_dependency|unknown_dependency`,
`409 open_plan_exists|draft_exists|dependency_cycle|not_draft`, `404 not_found`
(`:propose`). Dependency errors carry FE-facing detail: `unknown_dependency`
has `details.key` + `details.stage`, `dependency_cycle` has
`details.stages` — every stage on the cycle as `{ key, name }`.

## §4 — FE

- Route: `/projects/:id/plan/build`. Reachable from the live *Route 2* card on
  `/projects/:id/plan` (D7), and from **Keep editing** on a saved draft. GC and
  owner both see it (either may author).
- The editor seeds the standard skeleton (see `app/src/lib/plan-authoring.ts`) or
  **resumes an existing draft** (hydrated from `getPlan`), supports add / rename /
  reorder / remove of phases (actions) and tasks (sub-actions) and optional
  start/finish dates, shows a "Draft — only you can see it" status, and a primary
  **Save plan** that POSTs the tree and redirects to `/projects/:id/plan?drafted=…`.
- **Dependencies UI as built (LINA-240):** a "Depends on" control sits under
  every stage — a phase header and a task row alike, since a phase is a stage and
  may follow one (scope = any-stage). It opens a checkbox popover grouped by
  phase, each option printed `1.2 Framing` (the outline number is computed from
  POSITION, so a reordered row renumbers honestly, and a hand-typed prefix is
  stripped rather than doubled). Selected predecessors render as chips on the
  row. **No Gantt link-lines in v1** — that rides the deferred drag/Gantt §5
  item; chipping honestly beats drawing half a Gantt.
- **Dependencies (LINA-233):** the editor attaches each stage's local row id as
  `key` and, per stage, picks predecessors by id → sends `dependsOn` keys. The
  server resolves them to stage ids, so `getPlan` nodes arrive with `dependsOn`
  already joined — predecessor chips render from the ids on the task-detail
  drawer without any extra request. A `400 unknown_dependency` / `409
  dependency_cycle` (with the cycle stages) highlights the offending rows
  inline; "Save plan" stays disabled while a cycle exists.
- **Assignee + specialty tags (LINA-235):** the editor surfaces an owner picker
  per stage (seeded from the project members the FE already holds) and a
  `trade`/specialty label. Saving sends `assigneePartyId` and `trade` per node on
  the same draft-write; `getPlan` returns `assigneePartyId` + `trade` per stage,
  and avatars/initials are projected from the members directory — assigned ≠
  granted (an assignee gains no write access from being named on a stage; the
  permission model is unchanged). See the child FE issue for the picker work.
- On the plan page a saved draft shows (to its author only) a "Saved as a draft"
  banner and two actions: **Keep editing** (→ `/plan/build`) and **Send for
  approval** (`:propose`). The authorship stamp appears only after propose.
- On `409 open_plan_exists`/`draft_exists` the editor sends the author to the live
  plan rather than re-clicking a button that will keep 409-ing.
- The actor is never sent; authorisation is the server's. Affordances shape
  buttons only.

## §5 — Out of scope (ADR-0017 §5)

Drag-to-schedule and auto-schedule (the dependencies are authoritative data;
scheduling off them is a separate follow-up), task drawer, milestone/bug types,
third-level sub-tasks, paste-to-generate.
Deferred follow-ups, not mocked as dead controls.

> **LINA-235 note.** Per-task owner/assignee — previously in §5 out-of-scope — is
> now authored and persisted (`assigneePartyId` + `trade` per stage, this doc v4).
> The only remaining FE-side surface (assignee picker, avatar/initials rendering)
> is tracked as a child follow-up to LINA-235.
