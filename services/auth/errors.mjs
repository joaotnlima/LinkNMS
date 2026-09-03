// Auth & Authorization — typed errors (LINA-143).
//
// Same shape as the sibling services: every failure carries a stable `code` and
// an HTTP `status` so the API layer maps it to `{ error: { code, message } }`
// without re-classifying.

export class AuthError extends Error {
  /** @param {string} code @param {number} status @param {string} message */
  constructor(code, status, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

// The Bearer token could not be verified (missing / malformed / expired /
// signature-invalid). This is never a 403 — it means "we don't know who you
// are", so it is a 401.
export const unauthenticated = (msg = 'authentication required') =>
  new AuthError('unauthenticated', 401, msg);

// The party is known but the capability check denied the action (ADVANCE)
// (deny-by-default path of `can`).
export const forbidden = (msg = 'not permitted') =>
  new AuthError('forbidden', 403, msg);

// A uniqueness / state invariant would be violated (e.g. duplicate org
// membership, invalid webhook event). Distinct from 400.
export const conflict = (msg) => new AuthError('conflict', 409, msg);

export const badRequest = (msg) => new AuthError('bad_request', 400, msg);
