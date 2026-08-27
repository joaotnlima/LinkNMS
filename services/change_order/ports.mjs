// Typed ports the Change Order service depends on (ADR-0006 §1 — "no service
// reads another's schema; cross-service access goes through the owning service's
// typed interface, in-process now, HTTP later").
//
// This file declares three seams and provides in-memory implementations so this
// slice is provable on its own, before Slices 0/1/2 land their real adapters:
//
//   LedgerPort   — owned by Ledger & Budget (Slice 1). Appends hash-chained
//                  events and moves the budget. change_order NEVER touches
//                  ledger.audit_event / ledger.budget_event directly.
//   IdentityPort — owned by Identity & Membership (Slice 2). Authorizes every
//                  mutation; the acting party is server-derived (ADR-0004).
//   ChangeOrderStore — owned by THIS service (schema `change_order`).
//
// The real adapters will wrap Postgres (Slice 0/1) and speak the exact same
// method signatures. The contracts below are the announcement to those owners.

import { randomUUID } from 'node:crypto';

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A thrown-through conflict from the Ledger port when a budget_event already
// exists for a change order (UNIQUE(change_order_id)). Surfaced so the service
// can treat a duplicate budget move as an idempotent no-op, never a double-apply.
export class LedgerBudgetConflict extends Error {}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// In-memory Ledger port. Faithfully enforces the two invariants the Change
// Order slice relies on: hash-chained append order, and budget_event
// UNIQUE(change_order_id) so an approved CO moves the budget exactly once.
// ---------------------------------------------------------------------------
export function createInMemoryLedger({ baselines = new Map() } = {}) {
  const events = []; // { projectId, seq, type, actorPartyId, occurredAt, payload }
  const budgetEvents = new Map(); // changeOrderId -> { deltaCents }
  const seqByProject = new Map();

  function append(_tx, { projectId, type, actorPartyId, occurredAt, payload }) {
    const seq = (seqByProject.get(projectId) ?? 0) + 1;
    seqByProject.set(projectId, seq);
    const e = { projectId, seq, type, actorPartyId, occurredAt, payload };
    events.push(e);
    return e;
  }

  // Writes exactly one budget_event for a change order. A replay for a CO that
  // already moved the budget throws LedgerBudgetConflict (mirrors the Postgres
  // UNIQUE(change_order_id) violation) so the caller stays exactly-once.
  function recordBudgetEvent(tx, { projectId, changeOrderId, deltaCents, actorPartyId, occurredAt }) {
    if (budgetEvents.has(changeOrderId)) {
      throw new LedgerBudgetConflict(`budget_event already exists for ${changeOrderId}`);
    }
    budgetEvents.set(changeOrderId, { deltaCents });
    append(tx, {
      projectId,
      type: 'budget_moved',
      actorPartyId,
      occurredAt,
      payload: { changeOrderId, deltaCents },
    });
    return { budgetEventId: randomUUID(), changeOrderId, deltaCents };
  }

  function currentBudget(projectId) {
    const baselineCents = baselines.get(projectId) ?? 0;
    let approvedTotalCents = 0;
    for (const { deltaCents } of budgetEvents.values()) approvedTotalCents += deltaCents;
    return { baselineCents, approvedTotalCents, currentCents: baselineCents + approvedTotalCents };
  }

  return {
    append,
    recordBudgetEvent,
    currentBudget,
    // test introspection only
    _events: events,
    _budgetEvents: budgetEvents,
  };
}

// ---------------------------------------------------------------------------
// In-memory Identity port. Real impl is Identity & Membership (ADR-0004). Here
// we model the two R0 roles and the one capability rule that matters to this
// slice: any member may propose or decide; decide-your-own is blocked downstream
// in the service (two-sided rule) — Identity only answers membership/role.
// ---------------------------------------------------------------------------
export function createInMemoryIdentity({ memberships = [] } = {}) {
  // memberships: [{ projectId, partyId, role }]
  const byProject = new Map();
  for (const m of memberships) {
    if (!byProject.has(m.projectId)) byProject.set(m.projectId, new Map());
    byProject.get(m.projectId).set(m.partyId, m.role);
  }

  function roleOf(projectId, partyId) {
    return byProject.get(projectId)?.get(partyId) ?? null;
  }

  function requireMember(partyId, projectId) {
    if (!partyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
    const role = roleOf(projectId, partyId);
    if (!role) throw new DomainError(403, 'not_a_member', 'acting party is not a member of this project');
    return { partyId, projectId, role };
  }

  return { requireMember, roleOf };
}

// ---------------------------------------------------------------------------
// In-memory ChangeOrderStore — the schema `change_order` this service owns.
// Enforces, in code, the same invariants the SQL migration enforces in the DB,
// so the contract tests exercise real behaviour, not a lenient stub:
//   - CHECK (decided_by <> proposed_by)
//   - the proposed→decided one-way transition (atomic conditional update)
//   - UNIQUE(decision_idempotency_key)
// ---------------------------------------------------------------------------
export function createInMemoryStore() {
  const rows = new Map(); // id -> row
  const idempotencyKeys = new Set();

  function transaction(fn) {
    // Single-threaded in tests; the real adapter opens a Postgres tx here and
    // the ledger append + projection write commit together.
    return fn({});
  }

  function insert(_tx, row) {
    rows.set(row.id, { ...row });
    return { ...rows.get(row.id) };
  }

  function get(id) {
    const r = rows.get(id);
    return r ? { ...r } : null;
  }

  function listByProject(projectId) {
    return [...rows.values()]
      .filter((r) => r.project_id === projectId)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)))
      .map((r) => ({ ...r }));
  }

  // Atomic conditional decision write. Mirrors:
  //   UPDATE change_order SET status=?, decided_by=?, decided_at=?, idem=?
  //   WHERE id=? AND status='proposed'
  // Returns { applied, reason?, row }.
  function decide(_tx, { id, status, decidedByPartyId, decidedAt, idempotencyKey }) {
    const r = rows.get(id);
    if (!r) return { applied: false, reason: 'not_found', row: null };

    // DB CHECK (decided_by <> proposed_by).
    if (decidedByPartyId === r.proposed_by_party_id) {
      throw new DomainError(403, 'self_decision', 'a change order cannot be decided by its proposer');
    }
    // UNIQUE(decision_idempotency_key) — a key is spent exactly once.
    if (idempotencyKey != null && idempotencyKeys.has(idempotencyKey)
        && r.decision_idempotency_key !== idempotencyKey) {
      throw new DomainError(409, 'idempotency_key_reused', 'idempotency key already used for another change order');
    }

    if (r.status !== 'proposed') {
      return { applied: false, reason: 'already_decided', row: { ...r } };
    }

    r.status = status;
    r.decided_by_party_id = decidedByPartyId;
    r.decided_at = decidedAt;
    r.decision_idempotency_key = idempotencyKey ?? null;
    if (idempotencyKey != null) idempotencyKeys.add(idempotencyKey);
    return { applied: true, row: { ...r } };
  }

  return { transaction, insert, get, listByProject, decide, now, _rows: rows };
}
