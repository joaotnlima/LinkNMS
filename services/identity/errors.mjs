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

// A 400 that names the OFFENDING FIELD, so the account-setup screen can put the
// message beside the input that caused it instead of at the top of the form
// (api-me-profile-contract.md). `field` rides on the error object and the HTTP
// adapter copies it into the error body — the only place in this service where
// an error carries more than {code, message}, which is why it is a distinct
// constructor rather than a badRequest() with a hand-written body somewhere.
export const fieldError = (field, msg) => {
  const err = new IdentityError('bad_request', 400, msg);
  err.field = field;
  return err;
};

// First-login setup has already been completed for this party. A 409 and NOT an
// error the user should see: the client treats it as success and continues to
// the portal (a re-submitted form, a double-clicked button, or a back-navigation
// must not strand somebody outside their own record).
export const alreadySetup = () =>
  new IdentityError('already_setup', 409, 'profile already set up');

// The unauthenticated preview read (LINA-182) exceeded its per-key rate
// window. 429/429-scoped so a limiter trip stays inside the uniform envelope
// and never looks like a token-validity signal.
export const tooManyRequests = (msg = 'too many requests') =>
  new IdentityError('rate_limited', 429, msg);
