# POST /api/me/profile — API contract (LINA-137)

Contract-first spec for the account-setup endpoint consumed by the D0a-setup screen
([LINA-132](/LINA/issues/LINA-132)). Preserves the PROVISIONAL contract the frontend
ships against (`apps/web/src/onboarding/api.ts`) exactly; adds the formal detail the
server must honour.

> **Implementation status: LIVE in the portal ([LINA-189](/LINA/issues/LINA-189)).**
>
> This doc previously said "implemented" and pointed at `apps/api` + `services/auth`
> + the `authz` schema. That code exists and its tests pass, but **it was never
> deployed anywhere** — so from the user's side the endpoint did not exist, and
> account setup 404'd for every person who claimed a founding seat. "Implemented"
> meant "written", which is exactly the gap this note now closes.
>
> Code of record:
> - `app/src/app/api/v1/me/profile/route.ts` — the route (2 lines; no domain logic)
> - `services/identity/identity.mjs` `completeProfile` — validation + the
>   product-role → party-role mapping
> - `services/identity/pg-store.mjs` `completeProfile` — the atomic conditional UPDATE
> - `services/identity/migrations/0011_identity.sql` — `language`, `setup_complete`
>   on **`identity.party`**
> - Tests: `services/identity/profile.test.mjs`
>
> The write lands on `identity.party` — the table the whole R0 domain is keyed on —
> not on a separate `users` mirror. `display_name` IS the attribution name on every
> decision, change order, and audit row, so setup must write that row itself; a
> parallel profile that agrees with it only by convention is the integrity bug this
> product exists to prevent. The two dormant RBAC mirrors are retired by
> `0012_identity.sql`; see the "RBAC model" note below.

---

## Endpoint

```
POST /api/v1/me/profile
```

> **Path change (LINA-189).** This was specified as the unversioned
> `POST /api/me/profile` because it was designed for `apps/api`, a standalone
> Fastify service on its own origin. That service was never deployed — the portal
> is one Next app — so the browser posted same-origin and got a 404 on every
> submit. The endpoint now lives in the portal, on the same `/api/v1` surface as
> every other endpoint it serves.

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

## Server-side role handling

The client sends a **choice only** and never derives an entitlement. Role validation is
server-side; any role outside the two values is a 400 naming the `role` field.

| Wire value (the screen's vocabulary) | Stored `identity.party.role` |
|---|---|
| `owner` | `owner` |
| `general_contractor` | `contractor` |

`viewer` is a real party role but is deliberately **not** electable here: it is an
administrative state, not something a person chooses on the way in.

### The role grants nothing

**This is the important part, and it is a change from the original spec.** The role on
the party is a *description of what this person does* — a label beside their name. It
confers no access to any build. Access is `identity.membership`, minted only by creating
a project or accepting an invitation, and every capability check runs through the
ADR-0004 authorizer against *that*. A hand-crafted POST claiming `owner` therefore buys
the sender one thing: the word "owner" next to their own name, on a record they still
cannot reach.

### RBAC model — what happened to LINA-123

The original spec had this endpoint write a grant into the LINA-123 RBAC model
(`users · orgs · memberships · roles · permissions`). That model was built **twice** and
wired **zero** times:

- `authz.*` (`services/auth`, consumed by the undeployed `apps/api`), and
- `identity.users/orgs/memberships/roles/permissions/…` (migrations 0006/0007),

both carrying seeded catalogs and no user rows, while the running system authorized
every request through `identity.membership` + `services/identity/authz.mjs`. Three
parallel answers to "what may this person do" is not defence in depth, it is an
integrity hazard — the one that eventually gets answered differently by two of them.
LINA-189 keeps the model that is actually load-bearing and retires the other two
(`0012_identity.sql`). Re-introducing an org/role/permission catalog is a real decision
to make when orgs exist as a product concept; until then it is dead schema.

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
