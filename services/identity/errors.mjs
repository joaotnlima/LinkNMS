// Identity & Membership — typed errors.
//
// Every failure the service raises carries a stable `code` and an HTTP `status`
// so the API layer maps it to `{ error: { code, message } }` (design §6) without
// re-classifying. Handlers should never invent status codes from message text.

export class IdentityError extends Error {
  /** @param {string} code @param {number} status @param {string} message */
  constructor(code, status, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.status = status;
  }
}

// The acting party could not be established from the session. This is never a
// 403 (that means "we know who you are and you may not"); it means "we don't
// know who you are" — so it's a 401. The distinction matters for the audit story.
export const unauthenticated = (msg = 'no acting party in session') =>
  new IdentityError('unauthenticated', 401, msg);

// The party is known but the capability check (ADR-0004) denied the action.
export const forbidden = (msg = 'not permitted') =>
  new IdentityError('forbidden', 403, msg);

export const notFound = (what = 'resource') =>
  new IdentityError('not_found', 404, `${what} not found`);

// A uniqueness / state invariant would be violated (second counterparty, an
// already-accepted invitation, a re-used name). Distinct from 400 so the caller
// can tell "you sent something malformed" from "this collides with reality".
export const conflict = (msg) => new IdentityError('conflict', 409, msg);

export const badRequest = (msg) => new IdentityError('bad_request', 400, msg);
