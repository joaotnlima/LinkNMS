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
| `slo_class` | `mutation` | 3 | `read` \| `mutation` \| `chain_verify` — see §2 |
| `deployment.environment` | `production` | 2 | `preview` \| `production` |

### 1.2 Route templating is mandatory (cardinality guard)

The `route` attribute is the **template**, never the concrete path. `GET
/projects/9f3.../decisions` → `route="GET /projects/:id/decisions"`. Emitting the
raw path explodes cardinality by project count and re-introduces an id into
telemetry (a soft PII leak). Middleware must read the matched route pattern from
the router, not `req.url`. A route not in the §2 table must still map to a
template (`UNMATCHED`) so a mis-tag is visible rather than silent.

### 1.3 No PII, same rule as LINA-28 §3

No id, token, name, or free-text value ever becomes a metric attribute. The only
identifiers here are the *low-cardinality* `service`/`route`/`status` set above.
`project_id` and `actor_party_id` live on the product spine only.

---

## 2. Per-endpoint SLO map

Every R0 endpoint (design §6) classified. SLO class drives the target; the target
is on **p95** at R0 ledger sizes, error rate on the rolling 1h window.

| Route (template) | Owning service | SLO class | p95 target | Notes |
|---|---|---|---|---|
| `POST /projects` | identity | mutation | 500 ms | |
| `GET /projects/:id` | identity | read | 200 ms | composed read (budget+pillars); see §2.1 |
| `POST /projects/:id/invitations` | identity | mutation | 500 ms | |
| `POST /invitations/:token/accept` | identity | mutation | 500 ms | |
| `GET /projects/:id/decisions` | decision | read | 200 ms | |
| `POST /projects/:id/decisions` | decision | mutation | 500 ms | ledger append in-txn |
| `PATCH /decisions/:id` | decision | mutation | 500 ms | ledger append in-txn |
| `GET /projects/:id/change-orders` | change_order | read | 200 ms | |
| `POST /projects/:id/change-orders` | change_order | mutation | 500 ms | ledger append in-txn |
| `POST /change-orders/:id/decision` | change_order | mutation | 500 ms | two-sided approve + budget move |
| `GET /change-orders/:id` | change_order | read | 200 ms | the "one screen" answer (FR6) |
| `GET /projects/:id/audit` | ledger | **chain_verify** | **1 s** | runs chain-verify; **not** a plain read |
| `GET /projects/:id/plan` | schedule | read | 200 ms | |
| `POST /projects/:id/stages` | schedule | mutation | 500 ms | ledger append in-txn |
| `PATCH /stages/:id` | schedule | mutation | 500 ms | ledger append in-txn |
| `POST /stages/:id/progress` | schedule | mutation | 500 ms | ledger append in-txn |
| `POST /projects/:id/plan-document` | schedule | mutation | 500 ms* | *excludes blob transfer — see §2.2 |

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

1. **One completion middleware per service**, wrapping every `/api/v1` handler,
   emitting the three §1 instruments with the §1.1 attribute set on request
   completion (including thrown/5xx paths — use a `finally`/error boundary so an
   exception still records a data point with `status_class=5xx`).
2. **Route template from the router**, never `req.url` (§1.2). Unmatched → `UNMATCHED`.
3. **`slo_class` set from the §2 map**, co-located with the route definition so a
   new endpoint declares its class at birth (a route with no class fails the
   contract test in §7).
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

- **A1 — coverage:** every §2 route appears in the Row-3 table with a non-null
  p95 and a correct `slo_class`; zero requests land in `UNMATCHED`.
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
- **Open (non-blocking):** final OTLP backend choice (§6); whether chain-verify
  gets a cached/checkpointed path before the Row-4 trend breaches at scale
  (design §11) — I'll watch Row 4 and raise it with the Architect when the trend
  says so, not before.
