// Decision Log service — record & revise decisions, append-only (design §4.1,
// §6, Slice 3; owns schema `decision`).
//
// This is the same discipline as the ledger core: the domain logic is
// storage-agnostic. It orchestrates the trust-critical flow — authorize, then in
// ONE transaction append a ledger event and write the projection — over injected
// ports (`store`, `ledger`, `authz`), so the exact rules live in one place and
// the Postgres wiring (Slice 0/1/2) plugs in underneath without re-implementing
// them. The in-memory adapters in `memory-adapters.mjs` satisfy the same ports
// and exercise the REAL hash chain, so the tests prove the ledger event is
// genuinely chained — not stubbed.
//
// Two rules are load-bearing and enforced here, not in the UI:
//   1. A revision NEVER overwrites rev 1. Amendments append rev 2..n, each with
//      its own author + server timestamp (FR2).
//   2. Author and timestamp are server-authoritative on every write — taken from
//      the authenticated party and the server clock, never from the request body.

import { createNoopAnalytics } from '../analytics/analytics.mjs';

export class DecisionError extends Error {
  // status: HTTP status; code: stable machine code for the { error: {code,message} } envelope.
  constructor(status, code, message) {
    super(message);
    this.name = 'DecisionError';
    this.status = status;
    this.code = code;
  }
}

// Actions this service asks Identity & Membership (Slice 2, ADR-0004) to
// authorize. In R0 all three resolve to "is a member of the project", but naming
// them keeps the permission model explicit and future-proof (e.g. read-only
// parties later).
export const ACTIONS = Object.freeze({
  RECORD: 'record_decision',
  REVISE: 'revise_decision',
  VIEW: 'view_decisions',
});

const EVENT_RECORDED = 'decision_recorded';
const EVENT_REVISED = 'decision_revised';

function requireTitle(title) {
  if (typeof title !== 'string') throw new DecisionError(400, 'validation_error', 'title is required and must be a string');
  const trimmed = title.trim();
  if (!trimmed) throw new DecisionError(400, 'validation_error', 'title must not be empty');
  if (trimmed.length > 200) throw new DecisionError(400, 'validation_error', 'title must be at most 200 characters');
  return trimmed;
}

function normalizeBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw new DecisionError(400, 'validation_error', 'body must be a string');
  if (body.length > 20000) throw new DecisionError(400, 'validation_error', 'body must be at most 20000 characters');
  return body;
}

async function authorize(authz, actorPartyId, action, projectId) {
  if (!actorPartyId) throw new DecisionError(401, 'unauthorized', 'no acting party — authentication required');
  const allowed = await authz.can(actorPartyId, action, projectId);
  if (!allowed) throw new DecisionError(403, 'forbidden', `not permitted to ${action} in this project`);
}

// Shape a decision aggregate for the API: the immutable original (rev 1), the
// current view (latest rev), the "edited" flag, and the full revision history in
// chronological order. Revisions carry their own author + timestamp so the
// "who changed this, when" answer is a lookup (FR2, FR7).
function toView(decision, revisions) {
  const ordered = [...revisions].sort((a, b) => a.rev - b.rev);
  const original = ordered[0];
  const current = ordered[ordered.length - 1];
  return {
    id: decision.id,
    projectId: decision.projectId,
    createdByPartyId: decision.createdByPartyId,
    createdAt: decision.createdAt,
    currentRev: current.rev,
    edited: ordered.length > 1,
    title: current.title,
    body: current.body,
    original: { rev: original.rev, title: original.title, body: original.body, authorPartyId: original.revisedByPartyId, at: original.revisedAt },
    revisions: ordered.map((r) => ({
      rev: r.rev,
      title: r.title,
      body: r.body,
      authorPartyId: r.revisedByPartyId,
      at: r.revisedAt,
      auditEventId: r.auditEventId,
    })),
  };
}

// Factory. Ports:
//   store  — the `decision` schema projection. Must provide:
//              transaction(work) -> runs work(tx) atomically (BEGIN/COMMIT, ROLLBACK on throw);
//              within tx: insertDecision(row), insertRevision(row), setCurrentRev(id, rev),
//                         getDecisionForUpdate(id) -> row|null, maxRev(decisionId) -> int;
//              reads (no tx): getDecision(projectId, id), getDecisionById(id),
//                             listRevisions(decisionId), listDecisions(projectId).
//   ledger — Ledger & Budget port (ADR-0002/0006). append(tx, event) appends
//            `ledger.append_event(...)` inside the SAME transaction and returns
//            the persisted audit event ({ id, seq, entryHash, ... }).
//   authz  — Identity & Membership port. can(actorPartyId, action, projectId) -> boolean.
//   clock  — now() -> ISO-8601 string (server-authoritative timestamp).
//   ids    — () -> uuid string.
export function createDecisionLog({ store, ledger, authz, clock, ids, analytics = createNoopAnalytics() }) {
  if (!store || !ledger || !authz) throw new Error('createDecisionLog requires store, ledger, authz ports');
  const now = clock?.now ?? (() => new Date().toISOString());
  const newId = ids ?? (() => cryptoRandomId());

  // FR2 — record a new decision. rev 1 is the original.
  async function record(projectId, actorPartyId, input) {
    if (!projectId) throw new DecisionError(400, 'validation_error', 'projectId is required');
    await authorize(authz, actorPartyId, ACTIONS.RECORD, projectId);
    const title = requireTitle(input?.title);
    const body = normalizeBody(input?.body);

    const decisionId = newId();
    await store.transaction(async (tx) => {
      const occurredAt = now();
      // One transaction: ledger append FIRST, then the projection — the audit
      // event is the source of truth and the projection references it.
      const event = await ledger.append(tx, {
        projectId,
        type: EVENT_RECORDED,
        actorPartyId,
        occurredAt,
        payload: { decisionId, rev: 1, title, body },
      });
      await tx.insertDecision({ id: decisionId, projectId, createdByPartyId: actorPartyId, createdAt: occurredAt, currentRev: 1 });
      await tx.insertRevision({
        id: newId(), decisionId, rev: 1, title, body,
        revisedByPartyId: actorPartyId, revisedAt: occurredAt, auditEventId: event.id,
      });
    });
    // decision_logged — after commit, exactly one event per recorded decision.
    // No title/body content: only the id, a presence flag, and the body length
    // (§3 PII guard). actor_role is set as a PostHog person property on identify.
    analytics.decisionLogged({ projectId, actorPartyId, decisionId, body });
    return view(projectId, decisionId);
  }

  // FR2 — revise: append rev 2..n. rev 1 is never touched. Author + timestamp are
  // taken server-side, per revision.
  async function revise(decisionId, actorPartyId, input) {
    if (!decisionId) throw new DecisionError(400, 'validation_error', 'decisionId is required');
    const existing = await store.getDecisionById(decisionId);
    if (!existing) throw new DecisionError(404, 'not_found', 'decision not found');
    await authorize(authz, actorPartyId, ACTIONS.REVISE, existing.projectId);
    const title = requireTitle(input?.title);
    const body = normalizeBody(input?.body);

    let appendedRev;
    await store.transaction(async (tx) => {
      const locked = await tx.getDecisionForUpdate(decisionId);
      if (!locked) throw new DecisionError(404, 'not_found', 'decision not found');
      const occurredAt = now();
      const rev = (await tx.maxRev(decisionId)) + 1; // append past the current head
      appendedRev = rev;
      const event = await ledger.append(tx, {
        projectId: locked.projectId,
        type: EVENT_REVISED,
        actorPartyId,
        occurredAt,
        payload: { decisionId, rev, title, body },
      });
      await tx.insertRevision({
        id: newId(), decisionId, rev, title, body,
        revisedByPartyId: actorPartyId, revisedAt: occurredAt, auditEventId: event.id,
      });
      await tx.setCurrentRev(decisionId, rev); // pointer only — the prior rows stay
    });
    // decision_amended — confirms the append-only immutability promise is being
    // exercised (§1c amend-not-overwrite). Carries the new rev number, no content.
    analytics.decisionAmended({ projectId: existing.projectId, actorPartyId, decisionId, rev: appendedRev });
    return view(existing.projectId, decisionId);
  }

  // FR7 — full history, chronological. The homeowner and GC see decisions in the
  // order they were made.
  async function list(projectId, actorPartyId) {
    if (!projectId) throw new DecisionError(400, 'validation_error', 'projectId is required');
    await authorize(authz, actorPartyId, ACTIONS.VIEW, projectId);
    const decisions = await store.listDecisions(projectId);
    const out = [];
    for (const d of decisions) {
      const revisions = await store.listRevisions(d.id);
      out.push(toView(d, revisions));
    }
    return out;
  }

  async function view(projectId, decisionId) {
    const d = await store.getDecision(projectId, decisionId);
    if (!d) throw new DecisionError(404, 'not_found', 'decision not found');
    const revisions = await store.listRevisions(decisionId);
    return toView(d, revisions);
  }

  return { record, revise, list, view };
}

// Fallback id generator when no `ids` port is injected. Prefers crypto.randomUUID.
function cryptoRandomId() {
  // Lazy import avoids a hard node:crypto dependency in environments that inject ids.
  // eslint-disable-next-line no-undef
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `dec_${Math.random().toString(16).slice(2)}`;
}
