# AGENT-INDEX — LinkNMS platform revamp (v2)

**You are an engineering agent asked to rebuild the LinkNMS platform on the to-be design.** This file is
your entry point: read it completely before touching anything. It tells you what to read, what the sources
of truth are, what is decided, what is not, the order of work, and the rules you must not break.

Repo root: `~/projects/linkNMS`. All paths below are repo-relative.

---

## 0. Gate — check before writing any code

| Item | Status | If not confirmed |
|---|---|---|
| **D-03 migration path**: option A (new module schemas + `/api/v2`, keep platform pieces, retire v1 at cutover) | Recommended in [13](./13-gap-analysis.md), [18](./18-db-model-fit.md) — **confirm with the founder** | Stop. Do not start phase 1. |
| Proposed decisions D-19, D-20, D-33–D-37 ([01](./01-decisions.md)) | Proposed | Implement as written, behind the documented behaviour; list any you relied on in your report. Do not invent alternatives. |
| Open questions ([14](./14-open-questions.md)) | Open | Never decide them. Pick the documented default, flag it, move on. |

Everything else in [01](./01-decisions.md) marked **Accepted** is binding.

## 1. Mission

Replace the as-is domain (`services/`, `app/` on `/api/v1`) with the to-be modular monolith:
12 domain modules + platform, served on `/api/v2`, exactly as specified by the contract and the
executable data model. Then rebuild the UI on v2 and retire v1.

**Out of scope:** `marketing-site/`, `brand-book/`, the landing page, pricing numbers, validation
field work (`validation/`), the MCP *client* (only the MCP *server* is in scope, phase 10).

## 2. Sources of truth (in order of precedence)

1. [`01-decisions.md`](./01-decisions.md) — what was decided and why. Accepted > Proposed.
2. **Behaviour docs** (this folder) — how things must behave: `05` plan, `06` tendering & contracting,
   `04` visibility, `16` access (Clerk), `17` personas & interactions, `08` supporting domains, `09` state machines,
   `10` events, `11` API conventions.
3. **API contract** — [`api/v2/openapi.yaml`](../../../api/v2/README.md) (OpenAPI 3.1, 153 operations).
   Open `api/v2/index.html` to browse. `operationId`s are stable names.
4. **Data model** — [`db/v2/0001_schema.sql`](../../../db/v2/README.md) + `seed_casa_silva.sql` + `checks.sql`
   (`db/v2/verify.sh` must pass). Human-readable version: [15](./15-data-model.md).

**On conflict:** a higher source wins. Fix the lower one **in the same PR** and say so. If two sources of
the same rank disagree, or a behaviour is unspecified, **stop and ask**. Do not guess on money,
visibility, the ledger or authorization.

## 3. Minimum reading (in this order)

| # | Doc | Why you need it |
|---|---|---|
| 1 | [00-index](./00-index.md) | Map of the folder |
| 2 | [01-decisions](./01-decisions.md) | Binding decisions D-01…D-38 |
| 3 | [02-domain-map](./02-domain-map.md) | Modules, context map, rules between modules, target folder layout |
| 4 | [03-core-model](./03-core-model.md) · [15-data-model](./15-data-model.md) | Aggregates, invariants, tables, the seed scenario |
| 5 | [04-visibility-and-access](./04-visibility-and-access.md) · [16-access-model-clerk](./16-access-model-clerk.md) | V1–V8, edit scope, Clerk roles/permissions, `allow = permission ∧ relationship ∧ staffing ∧ entitlement` |
| 6 | [05-planning-and-execution](./05-planning-and-execution.md) | The core: WBS, links, propagation, baseline, variations, concurrency, cost roll-up |
| 7 | [06-tendering-and-contracting](./06-tendering-and-contracting.md) | Contract shapes, proposal lanes, award, change orders, measurements |
| 8 | [09-state-machines](./09-state-machines.md) · [10-domain-events](./10-domain-events.md) · [11-api-conventions](./11-api-conventions.md) | Lifecycles, outbox, wire rules |
| 9 | [13-gap-analysis](./13-gap-analysis.md) · [18-db-model-fit](./18-db-model-fit.md) | What to keep, change, drop from the as-is |
| 10 | [17-personas-roles-interactions](./17-personas-roles-interactions.md) · [19-mcp](./19-mcp.md) | Who does what; agent rules |

Product "why" (read once, do not change): [`../01-overview.md`](../01-overview.md), [`../02-problem.md`](../02-problem.md), [`../06-boundaries.md`](../06-boundaries.md).

## 4. Target architecture (one screen)

- **Modular monolith**, Node/TypeScript, PostgreSQL (Neon), Next.js 15 for UI + thin route adapters.
- One module per bounded context: `identity, directory, project, tendering, contracting, planning,
  quality, documents, collaboration, reputation, billing, record` + `platform` (outbox, holidays,
  viewer context, errors) and `query/` (viewer-projected read models).
- Layout per module: `domain/` (pure, no I/O) · `application/` (use cases, ports) · `infra/` (pg store,
  migrations, outbox) · `http/` (request → use case → `{status, body}`) — [02](./02-domain-map.md).
- **One schema + one least-privilege DB role per module; no cross-schema foreign keys.**
- **Clerk** = identity, organisations (households included), 7 roles, custom permissions, active org.
  **LinkNMS DB** = every relationship (participation, contracts, branch scope, staffing) — [16](./16-access-model-clerk.md).
- **Ledger**: `record.append_event()` in the **same transaction** as each domain write; scoped entries,
  redacted reads — [08](./08-supporting-domains.md).
- **Events**: transactional outbox; idempotent consumers; SSE per project — [10](./10-domain-events.md), [11](./11-api-conventions.md).

## 5. Work plan

Each phase ends with: migrations applied on the dev branch, handlers for the listed operations, tests
(including the invariants in §6), OpenAPI unchanged or updated in the same PR, docs in sync.
Deliver phase by phase through `feature → dev → main` (ADR-0022). Never skip dev validation.

| Phase | Scope | Operations (tags in openapi) | Tables (db/v2) | Done when |
|---|---|---|---|---|
| 0 | **Platform**: outbox + dispatcher, `ViewerContext`, problem+json, Clerk middleware (active org, `has()`), idempotency, OpenAPI lint in CI, `/api/v2` router | — | `platform.*`, `record.*` | `append_event` + outbox in one txn tested; CI lints the spec |
| 1 | **Identity & Access**: Clerk orgs + role sets + custom permissions; webhook mirror; staffing | Identity & Access | `identity.*` | Roles/permissions configured in Clerk dev instance; the matrix in 16 §5 has tests |
| 2 | **Project**: brief, locations, participants, invitations, calendar, share links | Project | `project.*` | `operating_model` derived (D-35) |
| 3 | **Contracting core**: contract tree, BoQ on tasks, signature, participation | Contracting (create/get/list/sign) | `contracting.contract, boq_item, contract_signature` | V2/V3 projections tested (checks §1) |
| 4 | **Planning core — the product**: rows, field deltas (LWW + `base`), links (anchors, lag), **server-side rigid propagation**, baselines per branch, segments, variations + digest, plan health, templates, Excel import, edit scope (D-33), SSE | Planning, Realtime | `planning.*` | Casa Silva propagation reproduces 15 Part 2; cost roll-up split by side (D-38); scope matrix = checks §3 |
| 5 | **Quality + money flow**: verification (≠ reporting org), NCs (closed by raiser), inspections; change orders (back-to-back, from variations), measurements, payment records, cash-flow | Quality, Contracting (rest) | `quality.*`, `contracting.*` | checks §8a/8b/8g/8h hold at API level |
| 6 | **Tendering**: RFP from rows, individual emails, proposal lanes (platform + email channel), clarifications, comparison, award → copy winner's plan on signature | Tendering | `tendering.*` | Lanes never enter planning roll-ups; bidders see only their own lane |
| 7 | **Collaboration & Documents**: comments/questions, minutes, activity, notifications, variation subscriptions; versioned documents on R2 with sha256 in ledger | Collaboration, Documents | `collaboration.*`, `documents.*` | Question lifecycle + digest notifications end to end |
| 8 | **Billing**: entitlements port (`billing.entitled`), sponsorship; provider behind the port (Clerk Billing vs Stripe + AT-certified invoicing is **open**) | Billing | `billing.*` | Reads of signed contracts never blocked by entitlements |
| 9 | **Directory & Reputation**: profiles, completeness, search, portfolio from completed contracts, reviews (double-blind), metrics | Directory, Reputation | `directory.*`, `reputation.*` | — |
| 10 | **MCP server** generated from `x-mcp-tool`; OAuth via Clerk; dry-run → confirm; `channel = mcp`; human-only excluded | (all tools) | — | "Compose the project" flow of 19 §3 works on the seed |
| 11 | **UI rebuild on v2** (plan grid first). Reuse per [13](./13-gap-analysis.md) "what carries over" | — | — | No UI code calls `/api/v1` |
| 12 | **Cutover**: export v1 record, retire v1 routes and schemas | — | drop as-is schemas | v1 removed; ledger export archived |

Phases 7–9 can run in parallel once phase 4 is merged (separate worktrees, separate modules).

## 6. Invariants — tests must prove these at the API level

1. Proposer never decides (change orders); the reporting org never verifies; only the raiser closes an NC.
2. A signed contract's BoQ line never changes in place: supersede + add through a change order.
3. Progress, field changes, baseline snapshots, document versions and ledger entries are append-only.
4. Every domain write and its ledger entry commit in one transaction. No entry means no change.
5. Money fields are **absent** (not null) for viewers without V2 rights or without `org:money:view`.
6. Owner never sees subcontract prices (V3). Bidders never see each other's lanes (V8).
7. Links are rigid (push and pull), keep durations, and never move started/done rows (D-22).
8. Unlinked rows never move by propagation (D-22). Propagation ignores edit scope; creating a link requires the successor in scope (D-33).
9. Field-level last-write-wins; an overwrite is reported to the overwritten author (D-26).
10. Depth ≤ 10 (D-25). One live prime per project (C3). Client ≠ supplier (C1).
11. Human-only operations (`x-human-only`) are never reachable through MCP.
12. The seed checks (`db/v2/verify.sh`) keep passing against the real migrations.

## 7. Rules of engagement

- **Contract first.** Change `api/v2/openapi.yaml` before (or with) the handler; regenerate `index.html` (`python3 api/v2/embed.py`).
- **Model first.** A table change updates `15-data-model.md`, `db/v2/*` and the module migration in one PR.
- **Applied migrations are immutable** (checksum guard): always add a forward migration.
- **Do not modify v1** (`services/`, `app/src/app/api/v1`) except to keep it running until cutover.
- **English** for code, docs, commits. User-facing copy is PT-PT first (i18n keys).
- **Reuse, don't reinvent** (from [13](./13-gap-analysis.md)): ledger writer and hash chain
  (`services/ledger/`), pure authorizer pattern (`services/identity/authz.mjs`), Excel import parser
  (`services/schedule/plan-import-parser.mjs`), Gantt geometry (`app/src/lib/plan-gantt.ts`, made
  work-day aware), grid UX (`PlanGrid.tsx`), Clerk wiring (`app/src/server/session.ts`), CI and
  migration guards (`.github/workflows`, `db/migrate.mjs`).
- **Worktrees:** one writing agent per worktree and module; only the integration owner edits shared
  manifests/lockfiles (see `CLAUDE.md`).
- **Never** commit secrets or `.env*`; never weaken a DB constraint to make a test pass.

## 8. Reporting back (end of each phase)

Post a short report containing:
1. what shipped (operationIds, migrations);
2. tests and their results (invariants in §6 by number);
3. any doc or contract changes, and why;
4. Proposed decisions relied on;
5. open questions hit, with the default you applied;
6. what is next.

## 9. Glossary

**Branch**: a row bound to a contract plus its descendants. **Lane**: one proposal drawn under a tendered row.
**Variation**: a recorded deviation from the baseline (time/cost/material/scope). **Segment**: a
render-ready bar piece (baseline, current, extension, delay_start, actual). **Wd**: working days on the
project calendar. **Prime / direct / sub / service**: contract kinds. **Clay**: the extension colour
(`status-pending-change`).
