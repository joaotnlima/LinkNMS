# API versioning & deprecation policy

**Status:** in force from 2026-09-25 (LINA-308, founder directive item 4).
**Applies to:** every HTTP API the platform serves (`/api/v1`, `/api/v2`, and any future version).

## Where API changes are documented

Every API change lands in **this folder** (`cowork/documentation/api/v2/`), in the same PR as the
change itself:

1. `openapi.yaml` is the contract — it changes **before or with** the handler, never after
   ([11-api-conventions](../../to-be/11-api-conventions.md)). Regenerate `index.html` with
   `python3 embed.py`.
2. `CHANGELOG.md` (this folder) gets one dated entry per change: operationIds touched,
   additive/breaking, and — for breaking — the deprecation plan (see below).
3. A new major version gets its own folder (`cowork/documentation/api/v3/…`) plus a migration
   guide written **at the moment v3 is introduced**, not at retirement.

## What counts as breaking

Additive and therefore allowed **within** a version: new endpoints, new optional request fields,
new response fields, new enum values on fields documented as open, new error codes.

Breaking and therefore requiring a **new version**: removing or renaming a path, field or enum
value; changing a field's type, meaning or unit; tightening validation on existing input;
changing an error code or status for an existing failure; changing authz semantics of an
existing operation.

Visibility rules are not versioning: a field becoming absent for a viewer because of
projection ([04-visibility](../../to-be/04-visibility-and-access.md)) is behaviour, not contract
change.

## Deprecation lifecycle

When vN+1 ships alongside vN, every vN operation follows this sequence:

| Step | Mechanism | Deadline |
|---|---|---|
| 1. Announce | vN responses gain `Deprecation: true` and `Sunset: <RFC 3339 date>` headers; CHANGELOG entry names the vN+1 replacement operationId per deprecated operation | Day 0 (vN+1 release) |
| 2. Migrate | All first-party clients (portal UI, MCP server) move to vN+1; CI check: no first-party code calls a sunset operation | ≤ day 10 |
| 3. Retire | vN routes return `410 Gone` with `problem+json` `code: "gone"` and a `Link` to the migration guide; schemas/dead code deleted | **≤ day 15** |

**15 days is the ceiling, not the target.** The founder's metric (LINA-308): a deprecation that
lives longer than 15 days is a smell — either the replacement is not really ready or the old
surface should already be gone. Pre-launch, with no external API consumers, steps 2–3 compress
to days; the full window exists only for operations with external callers (public RFP links,
MCP clients).

Exception requiring founder sign-off: an externally published URL that cannot be re-emailed
(e.g. tokened RFP links already in recipients' inboxes) may keep a **redirect** (not the old
implementation) past day 15.

## The v1 → v2 cutover (current case)

`/api/v1` predates this policy and is superseded wholesale by the pivot
([AGENT-INDEX](../../to-be/AGENT-INDEX.md), migration option A):

- v1 is **frozen** now: no new v1 endpoints; fixes only to keep the live portal working until
  the v2 UI ships.
- v1 retirement is **phase 12 of the pivot plan**, gated on the v2 UI serving all traffic and on
  founder approval; the ledger is exported and archived first. The 15-day clock for v1 starts
  the day the v2 UI is live in production, and is tracked in `CHANGELOG.md`.

## Compatibility guarantees within v2

- UUIDv7 ids are never re-minted; an id, once issued, is permanent.
- `operationId`s are stable names — code, docs and MCP tools reference them; renaming one is a
  breaking change.
- Unknown response fields must be ignored by clients (forward compatibility); unknown request
  fields are rejected with `validation_failed` (no silent drops).
- Error `code` values are a contract; new codes may be added, existing ones never repurposed.
