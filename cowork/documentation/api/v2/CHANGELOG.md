# API changelog

One dated entry per API change, newest first. Policy: [versioning-and-deprecation.md](./versioning-and-deprecation.md).

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
