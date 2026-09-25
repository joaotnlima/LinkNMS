# API changelog

One dated entry per API change, newest first. Policy: [versioning-and-deprecation.md](./versioning-and-deprecation.md).

## 2026-09-25 — Contracting core live (phase 3, additive; no contract change)

- Phase 3 shipped `modules/contracting` behind the contract: `createContract` (direct entry;
  Idempotency-Key honoured), `listContracts`/`getContract` (V2/V3 projection: parties full,
  everyone else `_visibility: scope` with commercial terms and `value` ABSENT — never null —
  and `value` additionally gated by `org:money:view`, invariant §6.5), `updateContract`
  (draft-only, client-only, If-Match on `version`), `signContract` (manager/admin of a party,
  x-human-only enforced against the MCP channel; both parties → `signed`, C3 one-live-prime
  answered as a 409 problem). Ledger entries are CONTRACT-scoped so V7 redaction hides them
  from non-parties. `contracting.contract.created`/`.signed` publish through the outbox;
  the project module consumes `.signed` into `project.participation` (source `contract`,
  capacity from the kind) — planning binds roots + baselines from the same event in phase 4.
- Rest of the tag (`sponsorContract`, `receiveProvisionally`, `closeContract`,
  `terminateContract`, change orders, measurements, payments, `financials`, `cash-flow`)
  lands with phase 5. Calling them still 404s.
- **Documented limitation:** `ContractCreate.supplier_email` (off-platform supplier) answers
  422 for now — the model requires a supplier organisation (`contracting.contract.supplier_org_id`
  NOT NULL) and the invite lane belongs to tendering/directory (phases 6/9). `Contract.value`
  is computed live from non-superseded BoQ lines; until phase 5 adds BoQ writes it is 0 for
  direct-entry contracts.
- DB: migration `db/v2/0004_contracting_contract_root.sql` — `contracting.contract_root`
  records which plan rows a DRAFT contract covers (`root_task_ids`); `planning.task.contract_id`
  is only stamped at signature, by planning, from the event (doc 15).

## 2026-09-25 — Project module live; invitation token in the 201 (additive)

- Phase 2 shipped `modules/project` behind the contract: `createProject`/`listProjects`/
  `getProject`/`updateProject` (If-Match optimistic concurrency on `version`), lifecycle commands
  `:claim`/`:cancel`/`:close` (doc-09 transition table + guards), `overview`, locations CRUD,
  participants, invitations + `:accept`, calendar (holidays merged from `platform.holiday`),
  share links. Every write ledgers on the same transaction (§6.4).
- `ProjectInvitation.token` added (response-only, additive): the raw invite token is returned once
  to the inviter in the 201 — only its SHA-256 lives in the DB. Rationale: the notifications module
  (email delivery) is a later phase; without the token in the response the accept flow would be
  unreachable. When notifications land, the field stays (harmless) but UIs should stop displaying it.
- `overview`/`listProjects` roll-ups (`end_date`, `cost`, `health`) are omitted and counters are 0
  until Planning (phase 4) / Contracting (phases 3+5) provide them — declared here so clients don't
  read the zeros as data.
- DB: migration `db/v2/0003_project_claim.sql` — `project.project.pending_owner_email` (who may
  claim a supplier-created draft, doc 14 Q4) + XOR constraint with `owner_org_id`.

## 2026-09-25 — path parameters declared everywhere; contract lint in CI (additive)

- Every templated path (110 of them) now declares its path parameters at path level
  (`in: path, required: true`, uuid format for `*Id` names). They were implied by the templates
  but never declared — invalid for codegen and Swagger "try it". Operation semantics unchanged.
- `scripts/openapi-lint.py` now gates the contract in CI (job **API v2 — contract lint**):
  unique operationIds, declared path params, resolvable $refs, global security default, colon-command
  convention (POST, or GET when read-shaped: `:download`, `:stream`, `:suggest`), fresh index.html embed.
- Phase-0 platform shipped against this contract: `/api/v2` router (problem+json per doc 11 §Errors,
  incl. `idempotency_mismatch` 409 for a reused Idempotency-Key with a different body), transactional
  outbox, ledger client, Idempotency-Key store (`platform.idempotency_key`, db/v2 migration 0002).

## 2026-09-25 — Gantt-parity + security fixes (additive)

All five gaps from [gantt-on-v2.md](./gantt-on-v2.md) §MISSING closed, plus one security spec bug
from [21-gap-review.md](../../to-be/21-gap-review.md) (S4):

- `uploadScheduleImport`: multipart request body added (`file` required, `parent_task_id` optional
  uuid = plan root when absent).
- `TaskDelta.changes`: `kind` added to the delta keys (task ↔ milestone; summary stays derived).
- `PlanTemplate.is_default` added (single default per person, personal/org scope);
  `listTemplates` gains `?default=true` — replaces v1 `GET /me/plan-template`.
- `streamEvents`: `Last-Event-ID` header param for resume (replay re-projected against current
  visibility); presence documented as connect-registers / disconnect-clears — no heartbeat op.
- `clerkWebhook`: `security: []` override (Svix-signed machine caller, not a Clerk session);
  verification headers documented.

## 2026-09-25 — v2 contract adopted; v1 frozen

- `openapi.yaml` (OpenAPI 3.1, 153 operations, 12 domain tags + platform) adopted as the v2
  contract (founder commit b7232f6, "revamp startup"; LINA-308).
- `/api/v1` is **frozen**: no new v1 endpoints; fixes only to keep the live portal running.
  Retirement = pivot phase 12, gated on the v2 UI serving all traffic + founder approval.
  The 15-day sunset clock starts the day the v2 UI is live in production.
- Known contract gaps found by the Gantt parity review ([gantt-on-v2.md](./gantt-on-v2.md)
  §MISSING) — to be fixed additively in `openapi.yaml`:
  1. `uploadScheduleImport` lacks a request body (multipart) and `parent_task_id`.
  2. No default-template resolve (v1 `GET /me/plan-template` equivalent).
  3. No operation changes a row's `kind` (task ↔ milestone).
  4. Presence signal for `streamEvents` unspecified.
  5. SSE resume (`Last-Event-ID`) and event envelope under-specified in the yaml.
