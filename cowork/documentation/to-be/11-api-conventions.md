# 11 — API conventions

## Transport
- REST + JSON over HTTPS, base path **`/api/v2`** (the as-is `/api/v1` stays until retired).
- One **OpenAPI 3.1** spec: [`api/v2/openapi.yaml`](../../../api/v2/README.md). It is the contract the UI,
  the implementation and the MCP server are built against, and it is maintained **contract-first**:
  endpoints land in the spec before the route handler. Operations carry `x-clerk-permission`,
  `x-relationship`, `x-mcp-tool` / `x-mcp-mode` and `x-human-only` ([19](./19-mcp.md)).
- Resources are nouns; **commands** that are not CRUD use the as-is colon convention on the resource:
  `POST /rfps/{id}:publish`, `POST /contracts/{id}:sign`, `POST /change-orders/{id}:approve`.

## Acting identity
- Clerk session → person. The **Clerk active organization** is the acting organization, with its role
  and permissions in the token ([16](./16-access-model-clerk.md)). Never taken from a header or the body.

## Ids, money, time
- UUIDv7 everywhere. Creation endpoints accept a client-supplied `id` (idempotent create: same id +
  same body → 200 with existing resource; same id + different body → 409).
- Money: `{ "amount_cents": 123450, "currency": "EUR" }`. Quantities: decimal strings (`"12.500"`).
- Dates: `YYYY-MM-DD` for schedule dates; RFC 3339 UTC for timestamps.

## Viewer projection
- Every response is projected for the viewer ([04](./04-visibility-and-access.md)). Fields the viewer
  may not read are **absent**, never `null`. The response carries `"_visibility": {"commercial": false}`
  on objects where commercial fields were withheld, so the UI can explain *why* instead of guessing.

## Concurrency & idempotency
- **Schedule rows (tasks, links, cost lines): field-level deltas, last write wins** (D-26).
  `PATCH` carries only changed fields, each with the `base` value the client saw:
  `{"changes": {"finish": {"value": "2026-10-16", "base": "2026-10-09"}}, "client_change_id": "uuidv7"}`.
  No `If-Match`. The server applies in arrival order and answers with the applied fields, the rows
  moved by propagation, and `overwrote[]` when a `base` did not match (the other author is notified).
- **Other aggregates** (contracts, change orders, proposals, profiles): `version` + `If-Match` →
  `409 version_conflict` with the current state. Commercial and contractual objects must not be
  silently overwritten.
- All `POST` commands accept `Idempotency-Key`; replays return the original result. On schedule
  deltas `client_change_id` plays the same role.

## Errors
RFC 9457 `application/problem+json`:
```json
{ "type": "https://linknms.com/errors/two_sided_rule", "title": "Proposer cannot decide",
  "status": 403, "code": "two_sided_rule", "detail": "…", "upgrade_hint": null }
```
Codes: `unauthenticated` 401 · `not_a_participant` / `forbidden` / `out_of_scope` (row outside the actor's branch scope, D-33) / `two_sided_rule` 403 ·
`not_entitled` 402 (with `upgrade_hint`) · `not_found` 404 · `version_conflict` /
`invalid_transition` / `dependency_cycle` 409 · `gone` 410 · `validation_failed` 422 (field errors) · `rate_limited` 429.

## Collections
Cursor pagination (`?cursor=…&limit=…`, response `next_cursor`), filtering with explicit query
params, sort with `?sort=field,-field`. No offset pagination.

## Schedule writes
- **Single-row commit** (the normal case): `PATCH /tasks/{id}` — see above. Response:
  `{ task, propagated: [{id, start, finish, cause}], variations: [...], overwrote: [...], health }`.
- **Structural batch** (atomic): `POST /projects/{id}/schedule:apply` for operations that must land
  together: `move_subtree`, `indent`, `outdent`, `insert_template`, `paste_rows`, `delete_subtree`.
- Date rules the server enforces (and the UI should pre-check with `:preview-move`): a drag on a linked
  row is stored as a new lag; `dependency_cycle` (409, with path), `too_deep` (422, depth > 10), `gone` (410).

## Real-time
`GET /projects/{id}/events:stream` — Server-Sent Events, filtered by viewer visibility, with
`Last-Event-ID` resume. Payload = event envelope ([10](./10-domain-events.md)) projected for the viewer.

## Files
`POST /documents` → returns `upload_url` (pre-signed) + `document_version_id`; client uploads bytes;
`POST /document-versions/{id}:complete` validates size/sha256. Downloads: `GET /document-versions/{id}:download` → 302 to a signed URL.

## Versioning & deprecation
Additive changes only within v2. Breaking change → v3 alongside, with a deprecation header on v2.
