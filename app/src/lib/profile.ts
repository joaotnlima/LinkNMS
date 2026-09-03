// Client-side data layer for the account-setup screen (D0a-setup, LINA-132).
//
// This talks to POST /api/me/profile on the standalone Fastify API (apps/api,
// LINA-137), authenticated with a Clerk session token. It is deliberately the
// ONLY place that knows the wire contract, so the screen component stays about
// layout and the response→outcome mapping is unit-testable without a DOM.
//
// The contract it honours verbatim: docs/architecture/api-me-profile-contract.md.
// Identity is NEVER sent in the body — the server reads clerk_user_id from the
// verified token (ADR-0004). The client sends a role CHOICE only; the grant is
// server-side.

export type Role = 'owner' | 'general_contractor';
export type Language = 'en' | 'pt' | 'es';

export interface ProfileInput {
  displayName: string;
  role: Role;
  language: Language;
}

/**
 * The outcome the screen acts on. Every branch maps to one thing the user sees:
 *  - `ok`         → continue to the portal (covers 200/201 AND 409, because a
 *                   profile that already exists is, for this screen, success).
 *  - `field`      → an inline error beside one input (400/422 with a field).
 *  - `unauthenticated` → the session is gone; send them back to sign in.
 *  - `retry`      → transient (429/5xx or a network throw); let them try again.
 *  - `error`      → anything else, shown as a general message.
 */
export type ProfileResult =
  | { kind: 'ok' }
  | { kind: 'field'; field: keyof ProfileInput; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'retry'; message: string }
  | { kind: 'error'; message: string };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

const RETRY_MESSAGE = 'Something went wrong on our end. Please try again.';

function apiUrl(path: string): string {
  // Trim a trailing slash so we never build `//api/...`; an empty base means
  // same-origin, which is the correct default when API and app are co-served.
  return `${API_BASE.replace(/\/$/, '')}${path}`;
}

/**
 * POST the account-setup form. `token` is a Clerk session JWT obtained from
 * `useAuth().getToken()` in the calling component.
 */
export async function submitProfile(
  token: string,
  input: ProfileInput,
): Promise<ProfileResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/me/profile'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
  } catch {
    // A network failure is retryable, never a validation error — treat it as
    // transient so the user's typed values survive and a retry is offered.
    return { kind: 'retry', message: RETRY_MESSAGE };
  }

  return interpretResponse(res.status, await readBody(res));
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const FIELDS: readonly (keyof ProfileInput)[] = ['displayName', 'role', 'language'];

function isField(v: unknown): v is keyof ProfileInput {
  return typeof v === 'string' && (FIELDS as readonly string[]).includes(v);
}

/**
 * Pure status→outcome mapping, split out so it can be tested without a fetch.
 * Exported for the unit test in profile.test.mjs.
 */
export function interpretResponse(status: number, body: unknown): ProfileResult {
  // 409 "already_setup" is idempotent success — the contract says the client
  // treats it as such and continues to the portal.
  if (status === 409) return { kind: 'ok' };
  if (status >= 200 && status < 300) return { kind: 'ok' };

  if (status === 401) return { kind: 'unauthenticated' };

  if (status === 400 || status === 422) {
    const err = errorOf(body);
    if (err && isField(err.field)) {
      return { kind: 'field', field: err.field, message: err.message ?? 'Please check this field.' };
    }
    return { kind: 'error', message: err?.message ?? 'Please check the form and try again.' };
  }

  if (status === 429 || status >= 500) {
    return { kind: 'retry', message: RETRY_MESSAGE };
  }

  const err = errorOf(body);
  return { kind: 'error', message: err?.message ?? 'Something went wrong. Please try again.' };
}

function errorOf(body: unknown): { field?: unknown; message?: string } | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      return {
        field: o.field,
        message: typeof o.message === 'string' ? o.message : undefined,
      };
    }
  }
  return null;
}
