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

  // ── Group-C plan/progress events (Slice 6, LINA-71 — extends LINA-28) ──────
  PLAN_DOCUMENT_UPLOADED: 'plan_document_uploaded',
  STAGE_ADDED: 'stage_added',
  STAGE_UPDATED: 'stage_updated',
  PROGRESS_REPORTED: 'progress_reported',
  PLAN_TIMELINE_VIEWED: 'plan_timeline_viewed',
});

// `surface` super-property enum (§2.2). Server-side domain writes are attributed
// to the surface the action belongs to so client read-events and server
// write-events share one funnel dimension.
export const SURFACE = Object.freeze({
  HOME: 'home',
  DECISIONS: 'decisions',
  CHANGES: 'changes',
  BUDGET: 'budget',
  PLAN: 'plan',
});

export const ROLE = Object.freeze({ OWNER: 'owner', COUNTERPARTY: 'counterparty' });

// ── Slice 6 plan/progress enums (functional spec §2 Q1 / §8) ─────────────────

// The four stage statuses. Status is the SOURCE OF TRUTH; the advisory percent
// is never a metric of record (spec §2 Q1) and must not carry a funnel.
export const STAGE_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  DONE: 'done',
});

// Human-readable label for a (from → to) pair, for breakdowns. This is a
// CONVENIENCE dimension only — the countable metric primitives are the four
// booleans computed in `classifyTransition` (entered_blocked, exited_blocked,
// is_reopen, is_correction), which are independent and non-exclusive. Never
// build a "how often does a stage block?" metric on transition_kind: a
// `done → blocked` reopen would be missed.
export const TRANSITION_KIND = Object.freeze({
  RE_REPORT: 're_report',
  CORRECTION: 'correction',
  REOPEN: 'reopen',
  BLOCK: 'block',
  UNBLOCK: 'unblock',
  COMPLETE: 'complete',
  START: 'start',
});

// Derived plan headline (spec §8.3 R1). Reported for context on plan events;
// PostHog is never the source of truth for it — it is recomputed on read.
export const PLAN_HEADLINE = Object.freeze({
  ATTENTION_NEEDED: 'attention_needed',
  COMPLETE: 'complete',
  IN_PROGRESS: 'in_progress',
  NOT_STARTED: 'not_started',
});

// How a stage edit changed the stage (spec §6 "edit vs reorder is worth
// separating if cheap"). A single save that both moves and edits a stage is ONE
// user action and must stay ONE event — hence the third value rather than two
// emissions.
export const STAGE_UPDATE_KIND = Object.freeze({
  EDIT: 'edit',
  REORDER: 'reorder',
  EDIT_REORDER: 'edit_reorder',
});

/**
 * Classify a status transition (spec §8.1) into the analytics dimensions.
 *
 * `transition_kind` uses first-match-wins precedence so the label is
 * deterministic; the four booleans are the metric primitives and are computed
 * independently, so `done → blocked` is BOTH a reopen and an entered_blocked.
 *
 * `not_started` is a real `from` value: per §8.1 a stage with zero progress
 * entries is `not_started`, so the first report always has a from-status.
 */
export function classifyTransition(from, to) {
  const isSelf = from === to;
  const kind = isSelf
    ? TRANSITION_KIND.RE_REPORT
    : to === STAGE_STATUS.NOT_STARTED
      ? TRANSITION_KIND.CORRECTION
      : from === STAGE_STATUS.DONE
        ? TRANSITION_KIND.REOPEN
        : to === STAGE_STATUS.BLOCKED
          ? TRANSITION_KIND.BLOCK
          : from === STAGE_STATUS.BLOCKED
            ? TRANSITION_KIND.UNBLOCK
            : to === STAGE_STATUS.DONE
              ? TRANSITION_KIND.COMPLETE
              : TRANSITION_KIND.START;

  return {
    transition_kind: kind,
    is_self_transition: isSelf,
    // Countable primitives — each answers one PM question directly.
    entered_blocked: to === STAGE_STATUS.BLOCKED && from !== STAGE_STATUS.BLOCKED,
    exited_blocked: from === STAGE_STATUS.BLOCKED && to !== STAGE_STATUS.BLOCKED,
    is_reopen: from === STAGE_STATUS.DONE && to !== STAGE_STATUS.DONE,
    is_correction: to === STAGE_STATUS.NOT_STARTED && from !== STAGE_STATUS.NOT_STARTED,
  };
}

/**
 * Plan percent complete (spec §8.3 R2): count of `done` stages ÷ total, FLOORED.
 * Equal weighting only — never cost- or duration-weighted, and the advisory
 * per-stage percent is excluded entirely. 100 is reachable only when every stage
 * is literally `done`.
 *
 * Duplicated here (rather than imported from the domain) on purpose: the number
 * we REPORT must be provably the R2 number, and this module is what the
 * analytics contract tests assert against.
 */
export function planPercentComplete(doneStageCount, stageCount) {
  if (!stageCount) return null; // zero stages ⇒ no headline at all (R1 case 5)
  return Math.floor((doneStageCount / stageCount) * 100);
}

/**
 * Plan headline status (spec §8.3 R1), first match wins. `blocked` outranks
 * everything — it is the homeowner's intervention signal and must never be
 * averaged away. Zero stages ⇒ null (render the empty state, never "0%").
 */
export function planHeadline({ stageCount, doneStageCount, blockedStageCount, inProgressStageCount }) {
  if (!stageCount) return null;
  if (blockedStageCount > 0) return PLAN_HEADLINE.ATTENTION_NEEDED;
  if (doneStageCount === stageCount) return PLAN_HEADLINE.COMPLETE;
  if (inProgressStageCount > 0 || doneStageCount > 0) return PLAN_HEADLINE.IN_PROGRESS;
  return PLAN_HEADLINE.NOT_STARTED;
}

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
    // Money must be integer cents, never a float (§2.2). `null` is permitted and
    // means "absent", which is a real state now that Slice 6 has an OPTIONAL
    // planned cost per stage (spec §2 Q2) — absence is not a float, and coercing
    // it to 0 would misreport an uncosted stage as a free one.
    if (lower.endsWith('_cents') && value != null && !Number.isInteger(value)) {
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
