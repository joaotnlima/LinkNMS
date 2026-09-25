# API changelog

One dated entry per API change, newest first. Policy: [versioning-and-deprecation.md](./versioning-and-deprecation.md).

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
