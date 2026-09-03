# POST /api/me/profile — API contract (LINA-137)

Contract-first spec for the account-setup endpoint consumed by the D0a-setup screen
([LINA-132](/LINA/issues/LINA-132)). Preserves the PROVISIONAL contract the frontend
ships against (`apps/web/src/onboarding/api.ts`) exactly; adds the formal detail the
server must honour.

> **Implementation status:** implemented. Ships with [LINA-123](/LINA/issues/LINA-123)
> (Neon RBAC schema) and [LINA-136](/LINA/issues/LINA-136) (Fastify `apps/api` scaffold +
> Clerk JWT verify) + Clerk key provisioning ([LINA-129](/LINA/issues/LINA-129) §7).
> Code: `apps/api/server.js` (route + error handler), `services/auth/profile.mjs`
> (domain service), `services/auth/pg-store.mjs` + `services/auth/store.mjs`
> (`completeProfile`, atomic), `services/auth/migrations/0003_authz_profile.sql`
> (`language`, `setup_complete`). Tests: `apps/api/server.test.mjs`.

---

## Endpoint

```
POST /api/me/profile
```

Persist the account-setup form (first login) and grant the chosen role in the Neon
Postgres RBAC model. Called once per user on first login; a repeat call is `409`.

## Authentication

```
Authorization: Bearer <Clerk session token>
```

- JWT verified server-side (`@clerk/backend`, LINA-129 spec §4b).
- **The Clerk `user_id` MUST come from the verified token, never the body.** A body
  that tries to supply its own user id is rejected/ignored (ADR-0004: acting identity
  is always from the credential).
- Scope is self-only: the acting user sets their **own** profile. Serverside identity
  resolves `clerk_user_id` → Neon `users` row via the RBAC wiring ([LINA-123](/LINA/issues/LINA-123)).

## Request body

```json
{
  "displayName": "string",
  "role": "owner" | "general_contractor",
  "language": "en" | "pt" | "es"
}
```

All three fields required.

| Field | Allowed values | Validation |
|---|---|---|
| `displayName` | any non-empty trim | required; trimmed; non-empty; max 200 chars |
| `role` | `owner` \| `general_contractor` | required; one of the two (server-validated) |
| `language` | `en` \| `pt` \| `es` | required; one of the three |

## Server-side role → permissions mapping

The client sends a **choice only** and never derives an entitlement. Role validation
**and** the RBAC grant are enforced server-side.

- `owner` → RBAC role for the homeowner permission set.
- `general_contractor` → RBAC role for the GC/counterparty permission set.

The concrete permission set and the RBAC rows the grant writes into are owned by
[LINA-123](/LINA/issues/LINA-123) (`users · orgs · memberships · roles · permissions`).
This endpoint consumes that model; it does not re-implement or duplicate it. Any role
outside the two values is a 400/422.

## Responses

### 200 / 201 — stored; role granted
Client treats 200 and 201 identically.

```json
{ "profile": { "displayName": "…", "role": "owner", "language": "en", "setupComplete": true } }
```

### 409 — already set up
Client treats as success and continues to the portal.

```json
{ "error": { "code": "already_setup", "message": "profile already set up" } }
```

### 400 / 422 — validation rejected
Optional per-field error so the message lands inline:

```json
{ "error": { "field": "displayName" | "role" | "language", "message": "…" } }
```

### 401 — session missing/expired
Client signs out and returns to sign-up.

```json
{ "error": { "code": "unauthenticated", "message": "…" } }
```

### 429 / 5xx — retryable
Client may retry with backoff.

## Integrity requirements

- **Identity from token, never body** — `clerk_user_id` and the resolved Neon row come
  only from the verified JWT.
- **Role grant + profile write are atomic** — no profile that says `owner` with an
  RBAC row that says GC. One unit of work, lazy-resolve on JWT/webhook race (LINA-129 §4b).
- **409 is idempotent- and race-safe** — two concurrent first-login POSTs yield one setup.
- **Self-only, no cross-party write.**
- Relationship to [LINA-123](/LINA/issues/LINA-123): this handler writes profile fields
  and grants the role **through** the RBAC model; any table it touches beyond its own
  profile/setup fields belongs to LINA-123's schema and is referenced, not redeclared.
