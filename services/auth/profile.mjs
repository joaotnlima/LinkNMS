// Auth — account-setup profile service (LINA-137).
//
// Validates the D0a-setup form (displayName, role, language) at the domain
// boundary, maps the product-role vocabulary to the RBAC role key, and
// delegates the atomic profile + membership write to the store. Identity is
// always taken from the verified-actor — never from the request body.
//
// The service is a pure function of its ports ({ store, sync }) and returns
// shaped results; it throws AuthError / FieldError for the caller to map to
// HTTP status codes.  See api-me-profile-contract.md for the wire contract.

import { unauthenticated, alreadySetup, fieldError } from './errors.mjs';

/** Product-facing role values accepted by the onboarding form. */
const ROLE_MAP = { owner: 'owner', general_contractor: 'gc' };
const ROLES = new Set(Object.keys(ROLE_MAP));
const LANGUAGES = new Set(['en', 'pt', 'es']);
const MAX_DISPLAY_NAME = 200;

/**
 * @param {Object} deps
 * @param {import('./store.mjs').createMemoryAuthStore} deps.store
 * @param {import('./sync.mjs').createAuthSyncService} [deps.sync]
 */
export function createProfileService({ store, sync } = {}) {
  if (!store) throw new Error('createProfileService requires store');

  /**
   * Complete the first-login account setup for the authenticated user.
   * @param {{ actor: { userId, clerkUserId, clerkOrgId }, input: object }} args
   * @returns {Promise<{ displayName: string, role: string, language: string, setupComplete: boolean }>}
   */
  async function completeProfile({ actor, input }) {
    // ── identity from token (ADR-0004: never from body) ──
    if (!actor?.clerkUserId) throw unauthenticated();

    // ── field validation ──
    const displayName = cleanDisplayName(input?.displayName);
    const roleRaw = validateRole(input?.role);
    const language = validateLanguage(input?.language);

    const roleKey = ROLE_MAP[roleRaw];

    // ── store the profile atomically (profile + membership) ──
    const result = await store.completeProfile({
      clerkUserId: actor.clerkUserId,
      clerkOrgId: actor.clerkOrgId ?? null,
      displayName,
      language,
      roleKey,
    });

    if (result.status === 'not_found') throw unauthenticated();
    if (result.status === 'already_setup') throw alreadySetup();
    if (result.status === 'bad_role') throw fieldError('role', 'role is not seated in the RBAC catalog');

    return { displayName, role: roleRaw, language, setupComplete: true };
  }

  return { completeProfile };
}

// ── validators (throw FieldError on bad input) ────────────────────────────────

function cleanDisplayName(raw) {
  if (typeof raw !== 'string') throw fieldError('displayName', 'displayName must be a string');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw fieldError('displayName', 'displayName is required');
  if (trimmed.length > MAX_DISPLAY_NAME) {
    throw fieldError('displayName', `displayName must be at most ${MAX_DISPLAY_NAME} characters`);
  }
  return trimmed;
}

function validateRole(raw) {
  if (typeof raw !== 'string') throw fieldError('role', 'role must be a string');
  if (!ROLES.has(raw)) throw fieldError('role', 'role must be "owner" or "general_contractor"');
  return raw;
}

function validateLanguage(raw) {
  if (typeof raw !== 'string') throw fieldError('language', 'language must be a string');
  if (!LANGUAGES.has(raw)) throw fieldError('language', 'language must be "en", "pt", or "es"');
  return raw;
}
