// Route-parameter normalisation and shape validation — the API boundary
// (LINA-79).
//
// TWO transports reach the same service handlers: the Next route files via
// app/src/server/gateway.ts `handle()`, and the server-rendered pages via
// app/src/lib/api.ts `call()` in process. Both previously carried their own copy
// of the `[id]` ⇄ `projectId` aliasing, and neither checked the SHAPE of an
// identifier before it became a Postgres parameter.
//
// The consequence was a server fault status for a client input error:
// `GET /api/v1/projects/not-a-uuid` reached `where id = $1` against a `uuid`
// column, Postgres raised `invalid input syntax for type uuid`, and the adapters'
// "an unmapped throw is a bug or an infrastructure failure" branch — correct in
// general — turned it into a `500 internal`. That is not merely cosmetic: the
// endpoint SLA spec (docs/architecture/r0-endpoint-sla-alerting-spec.md) counts
// 5xx against the error budget, so a crawler walking bad URLs would page us.
//
// The check lives HERE and not inside services/*/http.mjs on purpose. Those
// handlers are proven against in-memory adapters whose ids are deliberately
// synthetic (`proj-1`, `dec-2`) — the domain does not care that an id is a UUID,
// only Postgres does. So the shape check belongs at the edge where the outside
// world's strings arrive, which is exactly this module.
//
// It is a 400, not a 404. A malformed identifier cannot name a resource, so
// answering "bad request" reveals nothing about what exists — there is no
// enumeration difference to protect, and 400 is the honest classification.

/** Canonical UUID form; the `uuid` column type accepts nothing else. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The path params that are UUIDs in the schema. An explicit allowlist, not
// "everything except the ones we know are not": `:token` is a base64url
// invitation/sign-in secret and must never be forced into this shape, and a
// param added later should have to opt in deliberately rather than start
// silently unvalidated.
// `stageId` opted in with Slice B3 (LINA-218): D15 puts a stage id in the URL
// (/projects/:id/record/:stageId) and reads /stages/:stageId/materials off it, so
// a stale or hand-edited link is now a routine way for a non-UUID to reach the
// `uuid` column — exactly the 500 this module exists to prevent.
const UUID_PARAMS = new Set(['id', 'projectId', 'decisionId', 'changeOrderId', 'stageId', 'phaseId', 'rfpId', 'recipientId']);

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * A typed error in the same `{ status, code }` shape every service raises, so
 * both transports map it through their existing error path rather than needing a
 * new branch.
 */
export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParamError';
    this.code = 'bad_request';
    this.status = 400;
  }
}

/**
 * Alias `[id]` ⇄ `projectId` and reject malformed identifiers.
 *
 * The Next segment under /projects is `[id]`; the domain handlers name that param
 * `projectId` (Identity uses `id`). Getting the aliasing wrong does not fail
 * loudly — the handler reads `undefined`, asks Identity whether the party is a
 * member of project `undefined`, and returns a perfectly plausible 403 on the
 * owner's own project — so it happens once, here, for both transports.
 *
 * @param {Record<string,string>} params
 * @returns {Record<string,string>}
 * @throws {ParamError} 400 `bad_request` when a UUID param is not a UUID.
 */
export function normaliseParams(params = {}) {
  const out = { ...params };
  if (out.id && !out.projectId) out.projectId = out.id;
  if (out.projectId && !out.id) out.id = out.projectId;

  for (const name of UUID_PARAMS) {
    const value = out[name];
    // Absent is fine — not every route carries every param, and a handler that
    // genuinely needs one already returns its own typed error for a missing id.
    if (value === undefined || value === null || value === '') continue;
    if (!isUuid(value)) {
      // The name, never the value: a path param is attacker-controlled and this
      // message is returned to the caller.
      throw new ParamError(`${name} must be a UUID`);
    }
  }
  return out;
}
