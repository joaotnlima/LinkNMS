// Problem+json (RFC 9457) — the ONE error vocabulary of /api/v2.
//
// The codes and their statuses are the contract of to-be doc 11 §Errors,
// verbatim. A handler never invents a status: it names a code, and the code
// carries the status. That is what keeps the UI's error handling (and the MCP
// server's) a lookup instead of a guess.
export const ERROR_STATUS = Object.freeze({
  unauthenticated: 401,
  not_entitled: 402,
  not_a_participant: 403,
  forbidden: 403,
  out_of_scope: 403,
  two_sided_rule: 403,
  not_found: 404,
  version_conflict: 409,
  invalid_transition: 409,
  dependency_cycle: 409,
  idempotency_mismatch: 409,
  gone: 410,
  validation_failed: 422,
  too_deep: 422,
  rate_limited: 429,
  internal: 500,
});

const TITLES = Object.freeze({
  unauthenticated: 'Not signed in',
  not_entitled: 'Plan does not include this',
  not_a_participant: 'Not a participant of this project',
  forbidden: 'Not allowed',
  out_of_scope: 'Row outside your branch scope',
  two_sided_rule: 'Proposer cannot decide',
  not_found: 'Not found',
  version_conflict: 'Someone changed this first',
  invalid_transition: 'Not a legal state change',
  dependency_cycle: 'This link would create a cycle',
  idempotency_mismatch: 'Idempotency-Key was reused with a different request',
  gone: 'No longer available',
  validation_failed: 'Request is not valid',
  too_deep: 'Too many levels',
  rate_limited: 'Too many requests',
  internal: 'Something went wrong on our side',
});

/**
 * Build a problem+json body. `extra` merges extension members (e.g. `errors`
 * for validation_failed field errors, `upgrade_hint` for 402, `path` for
 * dependency_cycle) — never overrides the reserved members.
 *
 * @param {keyof typeof ERROR_STATUS} code
 * @param {string|null} [detail]
 * @param {Record<string, unknown>} [extra]
 */
export function problem(code, detail = null, extra = {}) {
  const status = ERROR_STATUS[code];
  if (!status) throw new Error(`unknown problem code: ${code}`);
  return {
    ...extra,
    type: `https://linknms.com/errors/${code}`,
    title: TITLES[code],
    status,
    code,
    detail,
  };
}

/**
 * Thrown by use cases; the http layer turns it into a response.
 * @param {keyof typeof ERROR_STATUS} code
 * @param {string|null} [detail]
 * @param {Record<string, unknown>} [extra]
 */
export class ProblemError extends Error {
  constructor(code, detail = null, extra = {}) {
    const body = problem(code, detail, extra);
    super(`${code}: ${detail ?? body.title}`);
    this.name = 'ProblemError';
    this.problem = body;
  }
}

/**
 * {status, headers, body} — what a route adapter needs to answer.
 * @param {keyof typeof ERROR_STATUS} code
 * @param {string|null} [detail]
 * @param {Record<string, unknown>} [extra]
 */
export function problemResponse(code, detail = null, extra = {}) {
  const body = problem(code, detail, extra);
  return {
    status: body.status,
    headers: { 'content-type': 'application/problem+json' },
    body,
  };
}
