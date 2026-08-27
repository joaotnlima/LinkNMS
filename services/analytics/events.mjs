// R0 analytics event contract — the single source of truth for PostHog event
// SHAPE (LINA-55, contract of record: LINA-28 doc `r0-metrics-posthog-spec`).
//
// This module is deliberately SDK-agnostic. It knows the Product-Analytics event
// catalogue (§2.3) and the identity/property conventions (§2.1–§2.2); it does NOT
// know how bytes reach PostHog — that is a sink's job (see ./sink.mjs). Keeping
// the shape here means one place to audit against the spec and one place the PII
// guard runs.
//
// Two invariants the analytics lead will verify, enforced here so a domain
// service can't accidentally violate them:
//   1. Money is always integer cents (`*_cents`), never a float.
//   2. No free-text / PII in properties — only ids, enums, *_len, has_*, *_cents.
//      `assertNoPii` is a hard guard, not a convention (§3).

// ── Group-A domain-write events (server-side spine, §2.3) ────────────────────
export const EVENTS = Object.freeze({
  PROJECT_CREATED: 'project_created',
  GC_INVITED: 'gc_invited',
  GC_JOINED: 'gc_joined',
  DECISION_LOGGED: 'decision_logged',
  DECISION_AMENDED: 'decision_amended',
  CHANGE_ORDER_RAISED: 'change_order_raised',
  CHANGE_ORDER_DECIDED: 'change_order_decided',
  BUDGET_EVENT_WRITTEN: 'budget_event_written',
});

// `surface` super-property enum (§2.2). Server-side domain writes are attributed
// to the surface the action belongs to so client read-events and server
// write-events share one funnel dimension.
export const SURFACE = Object.freeze({
  HOME: 'home',
  DECISIONS: 'decisions',
  CHANGES: 'changes',
  BUDGET: 'budget',
});

export const ROLE = Object.freeze({ OWNER: 'owner', COUNTERPARTY: 'counterparty' });

// Property keys that must NEVER appear in an event payload: names, titles, note
// bodies, tokens (§3). We match by substring so `title`, `co_title`,
// `scope_note`, `display_name`, `raw_token`, etc. are all caught.
const PII_KEY_SUBSTRINGS = ['title', 'name', 'note', 'body', 'token', 'email', 'secret', 'password'];
// A string property longer than this is treated as free-text (PII risk). Ids,
// enums, hashes and shas are all well under it; a UUID is 36 chars.
const MAX_STRING_PROP_LEN = 64;

/**
 * Hard PII / free-text guard (§3). Throws AnalyticsContractError if a property
 * key looks like PII or a string value looks like free text. Called on every
 * event before it reaches a sink, so a regression fails loudly in tests/dev
 * rather than silently leaking a homeowner's name into analytics.
 *
 * `body_len` / `has_body` are explicitly allowed — they encode length/presence,
 * not content.
 */
export function assertNoPii(properties, eventName = 'event') {
  for (const [key, value] of Object.entries(properties ?? {})) {
    const lower = key.toLowerCase();
    const isLenOrFlag = lower.endsWith('_len') || lower.startsWith('has_') || lower.endsWith('_count');
    if (!isLenOrFlag && PII_KEY_SUBSTRINGS.some((s) => lower.includes(s))) {
      throw new AnalyticsContractError(
        `PII guard: property "${key}" on ${eventName} is not allowed — send an id, *_len, has_* flag, or enum instead`,
      );
    }
    if (typeof value === 'string' && value.length > MAX_STRING_PROP_LEN) {
      throw new AnalyticsContractError(
        `PII guard: property "${key}" on ${eventName} is a long free-text string (${value.length} chars) — not allowed`,
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AnalyticsContractError(`property "${key}" on ${eventName} must be a finite number`);
    }
    // Money must be integer cents, never a float (§2.2).
    if (lower.endsWith('_cents') && !Number.isInteger(value)) {
      throw new AnalyticsContractError(`money property "${key}" on ${eventName} must be integer cents, got ${value}`);
    }
  }
  return properties;
}

export class AnalyticsContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalyticsContractError';
  }
}

// Whole hours between two ISO timestamps, rounded to one decimal. Uses SERVER
// timestamps only (§2.4) — both args are server-authoritative.
export function hoursBetween(fromIso, toIso) {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms / 3_600_000) * 10) / 10;
}
