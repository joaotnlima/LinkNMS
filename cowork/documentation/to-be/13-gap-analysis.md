# 13 — Gap analysis: as-is vs to-be

As-is = `services/` (identity, schedule, decision, change_order, ledger), `app/` (Next.js, `/api/v1`),
documented in `../architecture/`. Decision D-03: the migration path is chosen
**after** reading this table.

## Keep (moves over largely as-is)

| As-is | Why it survives |
|---|---|
| Modular services independent of Next; ports; `{status, body}` handlers | Exactly the to-be module shape |
| One schema + one least-privilege role per service; immutable checksummed migrations | Same rule in the to-be |
| `ledger.append_event()` hash chain, same transaction, advisory lock | The Record domain; only adds `scope` + redacted reads |
| Append-only `stage_progress`; status derived | Task progress in the to-be; add `verified` |
| Pure `can()` with frozen action enum; two-sided rule; DB CHECK `decided_by <> proposed_by` | Same principle; inputs change from role to relationships |
| Colon-action routes | Kept as the command convention |
| Excel plan import (inspect → columns → preview → confirm) | Becomes `schedule-imports`, targets the new Task model |
| Clerk as IdP; R2 for files; Neon Postgres; PostHog | Infrastructure unaffected |

## Change (concept survives, model must change)

| As-is | Problem | To-be |
|---|---|---|
| `membership` with `UNIQUE(project_id, role)` and roles owner/counterparty/subcontractor | One of each per project: a multi-party build cannot exist | `Participation` derived from contracts + relationship-based authorization ([04](./04-visibility-and-access.md)) |
| `party` (a person) with global `role` | The commercial actor is a company | `Organization` + `Person` + `OrgMembership` ([03](./03-core-model.md)) |
| `stage.id` re-minted on every draft save; `key` as the stable address | Kills a collaborative Gantt | UUIDv7 stable ids, client-generated |
| `plan_version` whole-tree freeze (draft → proposed → accepted) | Conflates the contractual baseline and the living schedule; post-baseline edits are impossible or become COs | Per-contract baselines + live forecast; time COs re-baseline ([05](./05-planning-and-execution.md)) |
| `stage_dependency` FS/SS/FF, no lag, no gate | Not enough for real scheduling | FS/SS/FF/SF + lag + `gate` |
| `change_order` + `budget_event` on the **project** | No contract ⇒ no confidentiality between owner and GC's subs | Change orders per **contract**, back-to-back links, BoQ deltas |
| `line_material` / `material_movement` | A cost breakdown with no contract or BoQ | Replaced by BoQ items + change orders (a material swap is a CO or a supplier-internal matter) |
| RFP, phases and sign-off inside `schedule` (ADR-0023) | Wrong boundary for a marketplace | Tendering module; phase sign-off becomes verification + contract reception |
| `decision` log | Useful, but isolated | Meeting minutes (acknowledged items) in Collaboration |
| Scattered status guards | Not legible | Declared transition tables ([09](./09-state-machines.md)) |
| Seats / entitlements / founding seats (ADR-0008/0013) | Per person, per project allowance | Billing module: subscription per organization, entitlements, sponsorship |
| `app/openapi.yaml` stub + per-service fragments | No single contract for the UI | One generated OpenAPI spec, `/api/v2` |

## New (does not exist)

Directory, Reputation, Contract tree + BoQ, Measurements & payment records, Quality
(verification queue, non-conformities, inspections), Collaboration questions + notifications,
transactional outbox + SSE, viewer-projection query layer, project calendar, Locations.

## Migration options (for D-03)

| Option | What it means | Cost | Risk |
|---|---|---|---|
| **A. New modules, new schemas, `/api/v2`, keep platform** | Reuse the platform pieces in "Keep"; write the domain modules fresh against the to-be; retire `/api/v1` and old schemas once the new UI is on v2 | Medium | Low — there are no paying users' data models to preserve |
| B. Evolve in place by migrations | Relax `membership`, add contracts, re-key stages, split `schedule` | High | High — every step drags the old invariants (`UNIQUE(project_id, role)`, plan-version freeze) along |
| C. Full rewrite incl. platform | Throw away the ledger, gateway, CI | Highest | Throws away the parts that are correct |

**Recommendation: A.** The five structural problems all sit in the domain model; the platform
underneath is sound. The existing production data (if any real builds exist) is exported via the
ledger export and re-imported as closed history, not migrated row by row.

Requirement-by-requirement verification of the as-is DB: [18](./18-db-model-fit.md).

## Suggested build order (after D-03)

1. Platform: outbox, Clerk active org + permissions ([16](./16-access-model-clerk.md)), viewer context, problem+json, OpenAPI generation.
2. Identity & Organization → Project + Locations.
3. Contracting core (contract tree, BoQ, sign) — needed before Planning can bind tasks.
4. Planning & Execution (plan API, field deltas, propagation engine, variations, SSE) — **the core**.
5. Quality (verification) → Contracting measurements & payment records.
6. Tendering.
7. Collaboration questions + notifications (can run in parallel from step 4).
8. Billing (entitlements can start as "allow all" behind the port from step 1).
9. Directory → Reputation.

## Planner (Gantt/WBS) UX vs the to-be APIs

Reviewed 2026-09-24 against the code behind `/projects/:id/plan/build`
(`app/src/app/projects/[id]/plan/build/PlanBuildEditor.tsx`, `PlanGrid.tsx`,
`app/src/lib/plan-authoring.ts`, `app/src/lib/plan-gantt.ts`). The dev portal itself sits behind
sign-in and was not inspected visually.

### Constraints baked into the current UX that the to-be removes or reverses

| # | Current behaviour | Where | To-be | Impact on UX |
|---|---|---|---|---|
| P1 | Every edit autosaves the **whole tree** (`POST plan-versions:author`, 900 ms debounce), last write wins for the whole plan | `PlanBuildEditor.flush` | Save on commit, **field-level deltas**, last write wins per field, author and time recorded, SSE (D-26) | Several people editing in parallel is the normal case; one person's save must never erase another's row. |
| P2 | Stage ids **re-minted on every save**; rows are "save first" (no status, no comments/files) until a save lands; a `key → id` map is refreshed after each save | `savedKeys`, `stageIdByKey` | Client-generated UUIDv7 | Every row is fully usable from creation. The whole "save first" state disappears. |
| P3 | Saving is **private drafting**, then "Send for approval" of the whole plan (draft → proposed → accepted) | ADR-0017/0019, `plan/page.tsx` | **No draft** (D-24): the plan is composed over time; a branch is baselined when its contract is signed | The approval workflow for the plan goes away. The core UX error of the as-is: a plan is not a draft. |
| P4 | Adding a link snaps the dependent's dates (client-side). `ends_with` **resizes** the dependent instead of shifting it; `enforceLink` does not cascade down the chain | `plan-authoring.ts` LINA-306 | Links drive dates (D-21) — **the intent is right** — but server-side, over the whole successor chain, duration kept, rigid (push and pull), only through explicit links, across organisations (D-22) | Keep the gesture; move the rule to the server; fix `ends_with` (end moves ⇒ dependent keeps its duration and starts later); dragging a linked row edits its lag. |
| P5 | Dates are **calendar days**; duration = end − start | `plan-gantt.ts` | Work days + PT holidays + project closures | The drag math, hover label ("8 days") and duration all need the project calendar. Non-working days should be shaded on the canvas. |
| P6 | **One date pair per row** | `TaskDraft.start/end` | current dates + baseline + actual; server returns render-ready segments (`baseline`, `current`, `extension` in clay, `delay_start`, `actual`) | Layered bars on controlled rows; variation badge; link to the change view. |
| P7 | Exactly **3 levels**, no milestones | ADR-0019 | 1–10 levels, user's choice; milestones; summaries derive dates and cost (D-25) | The depth cap and the phase/task/sub-task vocabulary go; a row is a task, summary or milestone. |
| P8 | Links FS/SS/FF (`starts_after` / `starts_with` / `ends_with`), no lag | ADR-0020 | Same three, stored as anchors (`from_anchor`, `to_anchor`) + optional lag (D-32) | No functional gap in link types. The link drawer gains a lag field. |
| P9 | Assignee = one **person** (party) among members; only GC/owner roles may author | `setAssignee`, authz `ADD_STAGE/UPDATE_STAGE` | Edit scope by **branch** (D-33): owner everywhere, GC in its branch incl. subs, sub/direct in their own branch; assignee inherited from the branch | Rows outside the viewer's scope render read-only (comment/question still available); the API returns `can_edit` per row. |
| P10 | Status settable by either party on any task (LINA-306) | `StatusControl`, authz `REPORT_PROGRESS` | **Kept** (D-31): anyone reports, attributed; `verified` added and must come from another organisation | Add the `verified` step; keep the status control open to all. |
| P11 | No cost column; specialty is free text | `PlanGrid` columns | **No contract column** (D-27). Cost column shown only where the row/subtree has cost lines visible to the viewer; summaries aggregate | Cost column and cost-line editor on the row; per-viewer values. |
| P12 | No real time | — | SSE per project | Presence and live row updates; the "draft saved" stamp becomes an activity indicator. |
| P13 | Procurement / Execution **phase accordion** on `/plan` (ADR-0023) | `plan/page.tsx` | Project status + Tendering module | The plan screen no longer hosts procurement. |

### What carries over unchanged
Grid layout (table + canvas, row-aligned), column resize/reorder/auto-fit, the split divider,
time-base nav (Fit/Weeks/Months/Quarters/Today), hover labels, click-to-schedule on an empty track,
promote/demote, parent status meter, detail drawer, connector geometry (`connectorPath`), cycle
detection before the request, Excel import wizard, names-only templates. The pure geometry in
`plan-gantt.ts` is reusable once it is made work-day aware.

### Gaps found in the to-be while doing this review
- **Plan templates** were missing from the API catalogue → added to [12](./12-api-catalogue.md).
- **Undated rows**: allowed in every phase, flagged by the plan-health check (D-28) → [05 §2, §9](./05-planning-and-execution.md).

### Decisions taken
P9 and P10 were settled by D-31 and D-33 (edit and status inside your branch scope; confirmation and
notification when not the assignee; `verified` from another organisation). Link types checked against
the app: no gap (D-32).
