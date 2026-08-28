# R0 Endpoint SLA — instrumentation, dashboard & alerting spec (LINA-41)

**Owner:** Product Analytics Lead · **Extends:** LINA-28 (`r0-metrics-posthog-spec`)
**Authority:** `docs/architecture/r0-technical-design.md` §10 + ADR-0006 §4 ·
**Parent:** LINA-26 (R0)

This is the spec Engineering builds to. It defines the **operational** telemetry
for every R0 endpoint — latency, error rate, throughput, status mix — its SLOs,
the dashboard, and the alert rules. It is the operational half of R0 measurement;
LINA-28 is the product half.

---

## 0. Two spines, one rule for which is which

R0 has **two** telemetry spines. They never mix.

| | Product spine (LINA-28) | Operational spine (this doc) |
|---|---|---|
| Question | *Did the behaviour happen?* (did they reach for the shared record) | *Did the endpoint serve it well?* (fast, without erroring) |
| Transport | PostHog | **OpenTelemetry** metrics → OTLP collector |
| Unit | a domain event (`decision_logged`) | a served HTTP request |
| Keyed by | `project_id`, `actor_party_id`, `surface` | `service`, `route`, `method`, `status_class` |
| Owner of shape | `services/analytics/events.mjs` | HTTP middleware in each service (this doc) |

**Rule:** operational SLOs are **never** inferred from product events. A request
that emits no product event (a `GET /audit`, a `404`, a rejected write) still
counts against latency and error SLOs. Product events are best-effort and
swallowed on failure (see `analytics.mjs`); operational metrics are not — they
are emitted for *every* request regardless of outcome.

---

## 1. Metric taxonomy (OpenTelemetry)

Three instruments, emitted by request-completion middleware on every service.
Names follow OTel HTTP semantic conventions so any OTLP-compatible backend
renders them without custom mapping.

| Instrument | Type | Unit | Purpose |
|---|---|---|---|
| `http.server.request.duration` | Histogram | seconds | latency p50/p95/p99 |
| `http.server.request.count` | Counter | requests | throughput + error rate + status mix |
| `http.server.active_requests` | UpDownCounter | requests | in-flight / saturation |

### 1.1 Attributes (the tag set)

Every data point carries **exactly** these attributes. This set is fixed — adding
a high-cardinality attribute (an id, a token) is a spec violation, not a judgment
call.

| Attribute | Example | Cardinality | Notes |
|---|---|---|---|
| `service` | `change_order` | 5 | schema-per-service name; the attributable unit |
| `route` | `POST /projects/:id/change-orders` | ~18 | **templated** — see §1.2 |
| `http.request.method` | `POST` | ~4 | |
| `http.response.status_code` | `200` | ~12 | exact code, for the status-mix panel |
| `status_class` | `2xx` | 5 | derived; the alerting dimension |
| `slo_class` | `mutation` | 4 | `read` \| `mutation` \| `chain_verify` \| `exempt` — see §2 |
| `deployment.environment` | `production` | 2 | `preview` \| `production` |

### 1.2 Route templating is mandatory (cardinality guard)

The `route` attribute is the **template**, never the concrete path. `GET
/projects/9f3.../decisions` → `route="GET /projects/:projectId/decisions"`.
Emitting the raw path explodes cardinality by project count and re-introduces an
id into telemetry (a soft PII leak). A route not in the §2 table must still map
to a template (`UNMATCHED`) so a mis-tag is visible rather than silent.

**Canonical parameter names.** The template's parameter names are the ones in
that endpoint's `openapi.yaml`, colon-form: `{projectId}` → `:projectId`,
`{changeOrderId}` → `:changeOrderId`, `{decisionId}` → `:decisionId`,
`{token}` → `:token`. Not a free choice — if one service emits
`/projects/:id/decisions` and another `/projects/:projectId/change-orders`, the
Row-3 table splits the same shape across two spellings and per-route comparison
stops working. The OpenAPI contract is the single source of the spelling.

### 1.3 No PII, same rule as LINA-28 §3

No id, token, name, or free-text value ever becomes a metric attribute. The only
identifiers here are the *low-cardinality* `service`/`route`/`status` set above.
`project_id` and `actor_party_id` live on the product spine only.

---

## 2. Per-endpoint SLO map

Every R0 endpoint (design §6) classified. SLO class drives the target; the target
is on **p95** at R0 ledger sizes, error rate on the rolling 1h window.

All routes are under the `/api/v1` server prefix (per each service's
`openapi.yaml` `servers:` entry); the `route` attribute omits that prefix.

### 2.a Shipped — contract exists in an `openapi.yaml`

Verified 2026-08-27 against `services/{identity,decision,change_order}/openapi.yaml`.
These are the routes A1 coverage is graded on today.

| Route (template) | Owning service | SLO class | p95 target | Notes |
|---|---|---|---|---|
| `POST /projects` | identity | mutation | 500 ms | |
| `GET /projects/:id` | identity | read | 200 ms | composed read (budget+pillars); see §2.1. Identity's contract names this param `{id}`, not `{projectId}` — §1.2 follows the contract |
| `POST /projects/:id/invitations` | identity | mutation | 500 ms | |
| `POST /invitations/:token/accept` | identity | mutation | 500 ms | |
| `GET /projects/:projectId/decisions` | decision | read | 200 ms | |
| `POST /projects/:projectId/decisions` | decision | mutation | 500 ms | ledger append in-txn |
| `PATCH /decisions/:decisionId` | decision | mutation | 500 ms | ledger append in-txn |
| `GET /projects/:projectId/change-orders` | change_order | read | 200 ms | |
| `POST /projects/:projectId/change-orders` | change_order | mutation | 500 ms | ledger append in-txn |
| `POST /change-orders/:changeOrderId/decision` | change_order | mutation | 500 ms | two-sided approve + budget move |
| `GET /change-orders/:changeOrderId` | change_order | read | 200 ms | the "one screen" answer (FR6) |

> **Contract drift note.** Identity spells the project param `{id}` where
> decision and change_order spell it `{projectId}`. §1.2 defers to each
> contract, so this is emitted faithfully rather than silently normalised — but
> it means the same entity reads two ways in the Row-3 table. Harmonising the
> OpenAPI contracts is the Architect's call, not mine; flagged, not blocked.

### 2.b Planned — classified now, graded when the slice lands

No `openapi.yaml` yet. Classified here so the route declares its `slo_class` at
birth (§5.3) rather than being retrofitted, and excluded from A1 until shipped.

| Route (template) | Owning service | SLO class | p95 target | Lands with |
|---|---|---|---|---|
| `GET /projects/:projectId/audit` | ledger | **chain_verify** | **1 s** | Slice 5 — runs chain-verify; **not** a plain read |
| `GET /projects/:projectId/plan` | schedule | read | 200 ms | Slice 6 |
| `POST /projects/:projectId/stages` | schedule | mutation | 500 ms | Slice 6, ledger append in-txn |
| `PATCH /stages/:stageId` | schedule | mutation | 500 ms | Slice 6, ledger append in-txn |
| `POST /stages/:stageId/progress` | schedule | mutation | 500 ms | Slice 6, ledger append in-txn |
| `POST /projects/:projectId/plan-document` | schedule | mutation | 500 ms* | Slice 6; *excludes blob transfer — see §2.2 |

### 2.c Exempt — instrumented, but no SLO and never alerting

These exist and serve traffic, so they *must* carry a real `route` template
(never `UNMATCHED`, which would fail A1), but they are infrastructure, not
product surface: no SLO target, excluded from every §4 alert and from the Row-1
summary.

| Route (template) | Owning service | Why exempt |
|---|---|---|
| `GET /health` | app (gateway) | liveness probe; high-volume, near-zero latency — would flatter every aggregate |
| `GET /api/docs` | app (gateway) | Swagger UI (ADR-0006) |
| `GET /api/docs/openapi.yaml` | app (gateway) | served contract |

Give them `slo_class=exempt` — a fourth value of the §1.1 `slo_class` attribute,
so "has no SLO" is an explicit tag rather than a missing one.

**Global error-rate SLO:** `5xx` rate < **1%** per `service` over the rolling 1h
window. `4xx` is *not* an error for SLO purposes (a rejected CO, a `403`, a `404`
is correct behaviour) — it is tracked on the status-mix panel but never alerts.

### 2.1 Composed reads
`GET /projects/:id` fans out to budget + four-pillar derivation. It is attributed
to `identity` (owns the project) at the edge; the derivation cost shows up as
child spans so a slow pillar computation is still attributable. If cached
(design §10: short-TTL + invalidate-on-append), the cache-hit path must stay well
under target; the SLO is measured on the served response including cache misses.

### 2.2 Plan-document upload
The 500 ms mutation target covers the **hash-anchor + ledger append**, not the
raw byte transfer to Blob. Middleware records a second timing span
(`blob.upload.duration`) excluded from the endpoint SLO so a large file on a slow
site connection does not read as an API regression. Alerting keys off the
API-work span only.

---

## 3. Dashboard spec

One dashboard, **"R0 Endpoint SLA"**, in the OTLP backend (Grafana or the
Vercel/OTel-native equivalent — see §6). Default window 1h, `deployment.environment`
selector defaulting to `production`.

**Row 1 — SLO summary (the "is R0 healthy" glance).**
- Per-`slo_class` p95 vs its target line: `read` (200 ms), `mutation` (500 ms),
  `chain_verify` (1 s). Green under, red over.
- Global `5xx` error rate vs the 1% line.
- **SLO budget burn** gauge per class (§4.1).

**Row 2 — Per-service attribution (the ADR-0006 §4 payoff).**
- p95 latency **by `service`** (5 series) — which service is dragging.
- `5xx` rate **by `service`**.
- Throughput (req/s) **by `service`** — load context for a latency move.

**Row 3 — Per-route detail (the drill-down).**
- Table: `route` × {p50, p95, p99, req count, `5xx` %, error-budget remaining},
  sorted by SLO-breach severity. This is the on-call's first click after an alert.
- Status-mix stacked bar per `route` (`2xx`/`3xx`/`4xx`/`5xx`) — distinguishes
  "slow" from "erroring" from "rejecting correctly".

**Row 4 — Chain-verify watch (trust-critical).**
- `GET /audit` p95/p99 trend vs 1 s, annotated with ledger size (entry count).
  Chain-verify latency grows with ledger length; this row is the early-warning
  that R0's linear verify needs the cached/checkpointed verify noted in design
  §11 before it breaches at scale.

Every panel filters to the same attribute set; no panel may introduce a query
that requires an attribute outside §1.1.

**Exempt routes (§2.c) are excluded from Rows 1, 2 and 4** and from every §4
alert — a `/health` probe firing every few seconds at ~1 ms would drag every
aggregate down and make the SLO summary read healthier than the product surface
actually is. They remain visible in the Row-3 table (so their absence is
detectable) behind a default-off "include exempt" toggle.

---

## 4. Alert rules

Alerts fire on **sustained** breach — never a single slow request. Sustained =
the condition holds over a rolling window long enough to exclude a cold-start or
a one-off GC. Two mechanisms, both required.

### 4.1 Latency & error-budget (burn-rate) alerts

Per `slo_class` **and** per `service`, using a multi-window burn-rate (Google SRE
pattern) so a fast catastrophic breach pages quickly while a slow bleed still
gets caught without flapping:

| Severity | Condition | Window | Route |
|---|---|---|---|
| **Page (fast burn)** | error budget burning ≥ **14.4×** | 5 min AND 1 h | owning service **+ CEO** |
| **Page (slow burn)** | error budget burning ≥ **6×** | 30 min AND 6 h | owning service **+ CEO** |
| **Warn** | p95 over target for a class | sustained 15 min | owning service only |

Error budget = 1% for error rate; for latency, the budget is the share of
requests allowed over the p95 target. "14.4× burn over 5m+1h" is the standard
fast-burn signal — it means the monthly budget would be exhausted in ~2 days at
that rate.

### 4.2 Hard-threshold safety net

Independent of burn rate, a blunt backstop so a total outage pages even before
the budget math resolves:

- Any `service` `5xx` rate > **5%** sustained **5 min** → **Page** (service + CEO).
- Any `slo_class` p95 > **2×** its target sustained **10 min** → **Page** (service + CEO).
- `GET /audit` (chain_verify) p95 > **1 s** sustained **10 min** → **Page** (ledger + CEO)
  — trust-critical path, so it pages, not warns.

### 4.3 Routing — who gets told

On a **Page**: the **owning service** (derived from the `service` attribute on
the breaching series → that team/agent) **and the CEO directly**, per CEO
direction on LINA-26 and ADR-0006 §4. On a **Warn**: owning service only; the
CEO is not paged for a warn.

R0 delivery channel: the alert posts to the owning-service issue thread and
raises a CEO-visible notification (a Paperclip issue comment + a direct
escalation). A PagerDuty/Opsgenie integration is the post-R0 upgrade; the routing
*policy* above is the durable part and does not change when the channel does.

### 4.4 Anti-noise guardrails
- No alert on `4xx` (correct rejections aren't incidents).
- Minimum request volume gate: a rate-based alert only fires above a floor
  (e.g. ≥ 20 req in the window) so 1 slow request out of 3 at 3am doesn't page.
- Every alert links straight to the Row-3 route table pre-filtered to the
  breaching `service`/`route`.

---

## 5. Instrumentation contract for Engineering

What each service must ship so this dashboard has data. This is the buildable
checklist.

1. **One completion wrapper per service**, wrapping every `/api/v1` handler,
   emitting the three §1 instruments with the §1.1 attribute set on request
   completion (including thrown/5xx paths — use a `finally`/error boundary so an
   exception still records a data point with `status_class=5xx`).

   *Where this goes, given the shipped design.* R0's service handlers are
   deliberately framework-agnostic: `services/change_order/http.mjs` exposes
   `({ session, params, body }) → { status, body }` functions and a thin gateway
   adapts the runtime request. **There is no router object to ask for a matched
   pattern.** So the wrapper is a decorator applied at the point each handler is
   registered, and the route template is **declared there as a static string**,
   not inferred from `req.url` (§1.2). Concretely — one table per service,
   sitting next to the handler map:

   ```js
   // route template + slo_class declared with the handler, per §2
   export const CHANGE_ORDER_ROUTES = [
     ['GET',  '/projects/:projectId/change-orders',      'read',     http.listChangeOrders],
     ['POST', '/projects/:projectId/change-orders',      'mutation', http.proposeChangeOrder],
     ['GET',  '/change-orders/:changeOrderId',           'read',     http.getChangeOrder],
     ['POST', '/change-orders/:changeOrderId/decision',  'mutation', http.decideChangeOrder],
   ];
   ```

   This keeps the metric shape out of the domain handlers (they stay
   framework-agnostic and their tests stay unchanged) while making the template
   a declared constant rather than a runtime guess. Also note the handlers
   return `{ status, body }` and map errors internally via `errorBody` — a 500
   is a *returned value*, not a throw, so the wrapper must read
   `result.status` for `status_class` and not rely on catching alone.
2. **`slo_class` declared with the route** (column 3 above), so a new endpoint
   declares its class at birth. A route registered without one fails the
   contract test in §7. Use `exempt` for §2.c infrastructure routes.
3. **The gateway tags what it dispatches.** Any request the gateway cannot match
   to a registered template still emits a data point with `route="UNMATCHED"` —
   visible, never dropped (§1.2).
4. **OTLP export**: metrics to the collector via OTLP; `service` =
   `service.name` resource attribute; `deployment.environment` from env. Export
   is fire-and-forget and must never block or fail a request (same non-blocking
   discipline as the analytics sink).
5. **Chain-verify child span** on `GET /audit` tagged with ledger entry count, so
   Row 4 can plot latency against size.
6. **Blob upload span** split out on `POST /plan-document` (§2.2).
7. **No id/token/name** in any attribute (§1.3) — enforced by the same
   substring guard style as `events.mjs assertNoPii`, applied to attribute keys.

Serverless note (design §10): under Vercel serverless, prefer OTel's metric
aggregation with flush-on-shutdown, or emit as structured log lines the collector
scrapes, to avoid a per-invocation exporter connection storm. Either is
acceptable; the *metric shape* above is what's fixed.

---

## 6. Backend / cost

Operational metrics ride OpenTelemetry → an OTLP-compatible store. R0 default:
whichever OTLP sink is already free/available in the Vercel+Neon stack (Vercel
OTel drain, or a hosted Grafana Cloud free tier). This is a **tooling** choice
Engineering/Architect finalize — this spec fixes the metric *shape*, SLOs, and
alert *policy*, which are backend-portable. Cost tracked on
`docs/architecture/tooling-integrations-cost.md`.

---

## 7. Acceptance criteria (my evidence gate)

LINA-41 is measurable when, on `preview` with synthetic traffic across all §2
routes:

- **A1 — coverage:** every **§2.a shipped** route appears in the Row-3 table
  with a non-null p95 and a correct `slo_class`, and every §2.c exempt route
  appears tagged `slo_class=exempt`; zero requests land in `UNMATCHED`. §2.b
  planned routes are graded by this same gate when their slice lands, not
  before — A1 is re-run per slice, not once.
- **A2 — attribution:** a fault injected into one service raises that service's
  `5xx` series and **no other** service's (per-service attribution proven).
- **A3 — SLO lines wired:** each `slo_class` panel shows its target line
  (200/500/1000 ms) and the global 1% error line.
- **A4 — alert routing dry-run:** a forced sustained breach fires a Page that
  reaches **both** the owning-service thread **and** the CEO; a forced `4xx`
  spike fires **nothing**.
- **A5 — no-PII audit:** a scrape of emitted attributes contains no id, token,
  name, or raw path (§1.3) — the same bar LINA-28 §3 holds the product spine to.

I verify A1–A5 before R0 operational readiness is called green, the same way I
gate the LINA-28 product spine.

---

## 8. Relationship to LINA-28 & open items

- **Shared discipline, separate transport:** PII guard, integer-cents, and
  "instrument with the feature, not after" carry over from LINA-28. Transport,
  keys, and ownership of shape differ (§0).
- **Open — for the Architect (non-blocking):** the §2.a project-param drift
  (`{id}` in identity vs `{projectId}` in decision/change_order). Harmonising
  the OpenAPI contracts is an API-design call, not an analytics one. Until it's
  decided the spec emits both spellings faithfully; whoever harmonises should
  update §2.a in the same change.
- **Open (non-blocking):** final OTLP backend choice (§6); whether chain-verify
  gets a cached/checkpointed path before the Row-4 trend breaches at scale
  (design §11) — I'll watch Row 4 and raise it with the Architect when the trend
  says so, not before.
