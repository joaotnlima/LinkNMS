# Slice B1 — Plan import from Excel: frozen data model, API contract, parser

- **Status:** Frozen (build against this) — 2026-09-08
- **Author:** Full-Stack Architect (Technical Lead)
- **Issue:** LINA-199 (Slice B1) · **Parent:** LINA-196 · **Anchors:** ADR-0012 §B,
  ADR-0002 (hash chain), ADR-0005 (schedule service), ADR-0006 §1 (append seam).
- **Pen screens:** D7–D10 (`cowork/pen/linkNMS.pen`, Bootstrap Flow Board).

ADR-0012 set the *direction* for Part B and left three items to be finalised in
the owning slice issue: the Excel **parser choice**, the **schema shape**, and
the one contract other work builds against. This doc freezes all three for B1 so
the delegated **BE** (LINA-199-BE) and **FE** (LINA-199-FE) children build in
parallel without schema churn. The architect owns the migration and merges both.

## 0. Non-negotiables (from the pen and ADR-0012 §B)

- **Never trust the client.** The browser uploads bytes only. Every
  interpretation — sheet list, column headers, row parsing, WBS hierarchy,
  dependency resolution — is derived server-side in the `schedule` service.
- **Never guess the tab.** Multi-sheet is the norm; the user selects the sheet
  explicitly. When a workbook has >1 sheet the UI must not auto-pick.
- **Nothing inferred.** Every stored field maps to a column the user explicitly
  assigned. No fuzzy header matching, no "looks like a date" coercion of an
  unmapped column.
- **Confirm = ONE stamped ledger event**, not N silent inserts. The whole import
  is a single recorded decision: *who imported which plan, when*.

## 1. Parser choice — `exceljs`

Use **`exceljs`** (MIT, actively maintained, streaming `.xlsx` reader). Parse in
the `schedule` service only.

Rejected: SheetJS **`xlsx`** — the maintained build has moved off the public npm
registry and the still-published community build carries a history of
prototype-pollution / ReDoS advisories. Not worth the supply-chain and CVE
surface for a server-side parse of untrusted files.

Hardening (BE child sets the exact numbers, FE echoes them):
- Reject anything whose extension/content-type is not `.xlsx` **and** fails to
  parse as a zip/OOXML workbook (both checks; extension alone is not trust).
- Enforce a **max file size** and **max row/column count**; a workbook that
  parses but is empty (no sheets, or the chosen sheet has 0 data rows) is a
  specific `400`, not a 500.

## 2. Ingest lifecycle (D8 → D10): stateless parse, single write

Four server calls. **No `schedule.*` row is written until Confirm.** There is no
server-side staging of the uploaded bytes — each interpreting step re-sends the
file (multipart). Plan files are small (KB–low MB); this keeps the flow stateless
and serverless-safe with no blob store or TTL sweeper to own.

All routes are GC-scoped (see §5) and live under the project.

| # | Screen | Route | Body | Returns | Writes? |
|---|--------|-------|------|---------|---------|
| 1 | D8 | `POST /api/v1/projects/{projectId}/plan-imports:inspect` | multipart `.xlsx` | `{ sheets: [{ name, rowCount }] }` | no |
| 2 | D9 | `POST …/plan-imports:columns` | multipart `.xlsx` + `sheet` | `{ columns: [{ index, header, sampleValues[] }], rowCount }` | no |
| 3 | D9→D10 | `POST …/plan-imports:preview` | multipart `.xlsx` + `sheet` + `mapping` | `{ roots: WBSNode[], warnings[], errors[], stats }` | no |
| 4 | D10 | `POST …/plan-imports:confirm` | multipart `.xlsx` + `sheet` + `mapping` + `idempotencyKey` | `{ importId, auditEventId, stageCount, rootCount }` | **yes (one txn)** |

- **`mapping`** assigns each target field to a source column *index* (never a
  header string — headers can repeat/blank):
  `{ action, subAction, start, end, trade, dependency }` → column index or null.
  **Required:** `action`, `start`, `end`. **Optional:** `subAction`, `trade`,
  `dependency`. Nothing is defaulted; an unmapped required field is a `400`.
- **Confirm re-parses server-side** from the re-sent file + mapping. The preview
  the client rendered is never trusted as the write payload.
- **Idempotency:** `confirm` records `idempotencyKey` uniquely on
  `schedule.plan_import`; a serverless retry with the same key returns the
  original `{ importId, auditEventId }` and writes nothing. (A genuinely new
  import of a corrected file uses a fresh key — re-import is allowed.)

`WBSNode` (preview + returned shape): `{ ref, action, subActionOf, start, end, trade, dependsOn: ref[], children: WBSNode[] }` where `ref` is the source row key.

## 3. Schema — migration `services/schedule/migrations/0002_plan_wbs_and_import.sql`

Owned and finalised by the architect. Forward-only; applied by the migrator role.

**ALTER `schedule.stage` ADD:**
- `parent_id uuid REFERENCES schedule.stage(id)` — WBS hierarchy. A top-level
  Action has `NULL`; a Sub-action points at its Action. Nullable.
- `trade text` — free-form trade label (pen "Trade"). Nullable.
- `import_id uuid REFERENCES schedule.plan_import(id)` — the batch that created
  this stage; `NULL` for hand-added stages.
- `source_row_ref text` — originating spreadsheet row key; provenance and the key
  used to resolve intra-import dependencies.

**CREATE `schedule.plan_import`** (append-only projection — INSERT + SELECT only,
no UPDATE/DELETE grant, mirroring `stage_progress` discipline):
`id, project_id, filename, sheet_name, column_mapping jsonb, row_count int,
idempotency_key text UNIQUE, imported_by_party_id uuid, imported_at timestamptz,
audit_event_id uuid`.

**CREATE `schedule.stage_dependency`** (many-to-many; a stage may list several
predecessors): `stage_id uuid REFERENCES stage(id)`,
`depends_on_stage_id uuid REFERENCES stage(id)`,
`PRIMARY KEY (stage_id, depends_on_stage_id)`,
`CHECK (stage_id <> depends_on_stage_id)`. INSERT + SELECT grant only.

**Grants:** `schedule_app` gains `SELECT, INSERT` on `plan_import` and
`stage_dependency`. `stage` already has `SELECT, INSERT, UPDATE`. The
`plan_import` **ledger** type needs **no new grant** — `schedule_app` already
holds `EXECUTE` on `ledger.append_event` (migration `ledger/0007`).

Ordering inside the Confirm transaction (FK discipline): insert the
`plan_import` header → insert `stage` rows (parents before children) → insert
`stage_dependency` rows → `ledger.append`. All or nothing.

## 4. Ledger event `plan_import` (ADR-0002 hash chain)

Exactly **one** event per import, appended through the existing
`ledger.append(tx, …)` seam **in the same Confirm transaction** as the projection
writes (same discipline as `stage_added`, `services/schedule/schedule.mjs`):

```js
await ledger.append(tx, {
  projectId,
  type: 'plan_import',
  actorPartyId,               // the GC party
  occurredAt,                 // server-authoritative now
  payload: {
    importId, filename, sheetName,
    columnMapping,            // the exact field→column assignment used
    stageCount, rootCount,
    stageIds: [...],          // WBS pre-order — deterministic so payload_hash is stable
  },
});
```

This single event is the audit answer for the whole batch. It is deliberately
**not** N `stage_added` events: an import is one decision by one party at one
time. `stageIds` is emitted in a deterministic (WBS pre-order) order so the
canonical-JSON `payload_hash` is reproducible on verify.

## 5. Permissions

GC-only. The plan is the counterparty's (GC's) to import; the homeowner/owner
does **not** import — they review the proposed baseline in **B2**. Authorize
through the existing `identity.authorize({ actorPartyId, action, projectId })`
seam with a new action **`IMPORT_PLAN`**, scoped to `projectId` and granted to
the GC/counterparty role only. `actorPartyId` comes from the session, never the
body.

## 6. WBS depth

The pen models two levels — **Action / Sub-action**. The `parent_id` self-ref
*permits* arbitrary depth, but the B1 parser **enforces exactly two**: a
Sub-action's parent must be an Action; deeper nesting is a validation error
surfaced in preview. This matches the pen and keeps the D10 mini-gantt legible.
Deeper/re-parentable WBS is a B2+ question, not smuggled in here.

## 7. FE contract (D7–D10) — build in parallel against §2

- **D7** — GC empty-build state offering the routes; "Import from Excel" is
  route 1.
- **D8** — `.xlsx` picker → `:inspect` → **sheet selector** (radio/select; never
  auto-pick when >1 sheet). Download-template link (static asset — see open
  items). Bad/empty-file `400`s surfaced inline, file kept for retry.
- **D9** — column-mapping grid: every target field explicitly assigned to a found
  column; required = action/start/end; warn on unmapped columns and missing
  required; **live "stored shape" preview** driven by `:preview`.
- **D10** — WBS tree + **mini-gantt** from `:preview`; **Confirm** calls
  `:confirm` with a fresh `idempotencyKey`; on success route to the plan/record
  and show the returned `auditEventId` as the stamp.

## 8. Open items (finalised in the child issues, not here)

- **Exact size/row/column limits** — BE child sets, FE echoes in client-side
  validation.
- **Template `.xlsx`** contents and where the static asset lives — Product
  Designer + Docs provide; FE links it. Not a blocker for the parse path.
- **Dependency column format** — B1 resolves intra-import predecessor refs by
  `source_row_ref` token(s) in the mapped Dependency cell (comma/semicolon
  separated). Cross-plan or external dependencies are out of scope for B1.

## 9. What this unblocks

B1 is the data-model floor for the whole plan/baseline epic. **B2 (LINA-200)**
adds versioning + the proposal→baseline lifecycle **on top of these tables**, and
**B3 (LINA-201)** adds materials/budget-movement on top of B2. Both are
`blockedBy` B1's BE child until the migration and event land on `main`.
