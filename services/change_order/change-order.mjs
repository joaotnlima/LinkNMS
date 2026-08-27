// Change Order service — lifecycle, two-sided approval, budget move, and the
// "one screen" answer (LINA-39 / design §4.2, §5, §6; ADR-0004; FR3–FR6, FR8).
//
// This is where the trust rules of a change order live:
//   - a CO opens *proposed*; scope/schedule/quality are captured but never touch
//     the budget (FR3, FR8);
//   - it can be decided only by a member who is NOT the proposer — asserted here
//     AND by the DB CHECK (decided_by <> proposed_by) (FR4);
//   - approving moves the budget exactly once, via the Ledger port, guarded by
//     an idempotency key AND ledger.budget_event's UNIQUE(change_order_id) so a
//     serverless retry can never double-apply (FR5);
//   - GET /change-orders/:id is the one-screen answer: who decided, when, the
//     cost delta, and budget before→after (FR6).
//
// It owns no persistence maths of its own: the ledger append + budget move are
// the Ledger service's; membership/authorization is Identity's. This module is
// pure orchestration over the three ports (see ports.mjs).

import { randomUUID } from 'node:crypto';
import { DomainError, LedgerBudgetConflict } from './ports.mjs';

const now = () => new Date().toISOString();

// A budget move already applied for this CO (budget_event UNIQUE(change_order_id))
// is an idempotent no-op, never a double-apply. The in-memory ledger (ports.mjs)
// and the real pg ledger (../ledger/pg-ledger.mjs) each throw their OWN
// `LedgerBudgetConflict` class, so a plain `instanceof` against one misses the
// other. We match on the class NAME as well so the exactly-once guarantee holds
// across both adapters. (Follow-up for the Ledger owner: promote this to a single
// shared error type so the name-match crutch can go.)
function isBudgetConflict(err) {
  return err instanceof LedgerBudgetConflict || err?.constructor?.name === 'LedgerBudgetConflict';
}

// Move the budget, absorbing a duplicate (budget_event UNIQUE(change_order_id))
// as the idempotent no-op it is — WITHOUT poisoning the outer transaction.
//
// On real Postgres a failed INSERT aborts the whole transaction, so simply
// catching the LedgerBudgetConflict in JS is not enough: the enclosing COMMIT
// would still roll the decide back (the CO would never flip to approved). We wrap
// the move in a SAVEPOINT so a conflict rolls back ONLY the budget insert and the
// surrounding decide+append survive. The in-memory adapter passes a plain `{}` tx
// with no `query`, so there the savepoint steps are skipped and the JS catch alone
// suffices — one code path, both adapters.
async function moveBudgetAbsorbingDuplicate(tx, doMove) {
  const sql = typeof tx?.query === 'function' ? (s) => tx.query(s) : null;
  if (sql) await sql('SAVEPOINT co_budget_move');
  try {
    await doMove();
    if (sql) await sql('RELEASE SAVEPOINT co_budget_move');
  } catch (err) {
    if (!isBudgetConflict(err)) throw err;
    // The budget already moved for this CO → un-poison the tx and treat as a no-op.
    if (sql) await sql('ROLLBACK TO SAVEPOINT co_budget_move');
  }
}

// Every port method is awaited: the in-memory adapters return plain values
// (awaiting them is a harmless no-op) while the Postgres adapters are async, so
// one service body drives both. The mutating handlers open a store transaction,
// do the projection write + ledger append/budget-move on that SAME connection so
// they commit together (ADR-0006 §1), and only THEN read the one-screen `view`
// from committed state.
export function createChangeOrderService({ store, ledger, identity }) {
  if (!store || !ledger || !identity) {
    throw new Error('createChangeOrderService requires { store, ledger, identity } ports');
  }

  // ---- propose (opens *proposed*) — FR3, FR8 ------------------------------
  // POST /projects/:id/change-orders
  async function propose(projectId, actorPartyId, input) {
    await identity.requireMember(actorPartyId, projectId); // any member may propose (ADR-0004)

    const { title, costDeltaCents } = input ?? {};
    if (!title || typeof title !== 'string') {
      throw new DomainError(400, 'invalid_title', 'title is required');
    }
    if (!Number.isInteger(costDeltaCents)) {
      throw new DomainError(400, 'invalid_cost', 'costDeltaCents must be an integer (cents)');
    }
    if (input.scheduleImpactDays != null && !Number.isInteger(input.scheduleImpactDays)) {
      throw new DomainError(400, 'invalid_schedule_days', 'scheduleImpactDays must be an integer');
    }

    const id = randomUUID();
    const createdAt = now();
    const row = {
      id,
      project_id: projectId,
      decision_id: input.decisionId ?? null,
      title,
      cost_delta_cents: costDeltaCents,
      status: 'proposed',
      proposed_by_party_id: actorPartyId,
      decided_by_party_id: null,
      created_at: createdAt,
      decided_at: null,
      scope_impact_note: input.scopeImpactNote ?? null,
      schedule_impact_days: input.scheduleImpactDays ?? null,
      schedule_impact_note: input.scheduleImpactNote ?? null,
      quality_flag: !!input.qualityFlag,
      quality_note: input.qualityNote ?? null,
      decision_idempotency_key: null,
    };

    await store.transaction(async (tx) => {
      await store.insert(tx, row);
      // The proposal is a ledgered event; proposing never moves the budget.
      await ledger.append(tx, {
        projectId,
        type: 'change_order_proposed',
        actorPartyId,
        occurredAt: createdAt,
        payload: {
          changeOrderId: id,
          title,
          costDeltaCents,
          decisionId: row.decision_id,
          scopeImpactNote: row.scope_impact_note,
          scheduleImpactDays: row.schedule_impact_days,
          scheduleImpactNote: row.schedule_impact_note,
          qualityFlag: row.quality_flag,
          qualityNote: row.quality_note,
        },
      });
    });
    return view(id); // one-screen view from committed state
  }

  // ---- decide (approve | reject) — FR4, FR5 -------------------------------
  // POST /change-orders/:id/decision   body { decision, idempotencyKey? }
  //
  // Two-sided rule enforced in code (403 here) AND by the DB CHECK. The budget
  // moves only on approve, only inside this transaction, exactly once.
  async function decide(changeOrderId, actorPartyId, { decision, idempotencyKey } = {}) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new DomainError(400, 'invalid_decision', "decision must be 'approve' or 'reject'");
    }

    const existing = await store.get(changeOrderId);
    if (!existing) throw new DomainError(404, 'not_found', 'change order not found');

    await identity.requireMember(actorPartyId, existing.project_id); // member of THIS project

    // FR4 — a proposer can never decide their own CO. Checked before we touch
    // the DB so the caller gets a clean 403; the CHECK is the backstop.
    if (actorPartyId === existing.proposed_by_party_id) {
      throw new DomainError(403, 'self_decision', 'you cannot decide a change order you proposed');
    }

    // Idempotent replay: same key, already decided → return the prior result
    // rather than 409. This is what makes a serverless retry safe.
    if (idempotencyKey != null
        && existing.status !== 'proposed'
        && existing.decision_idempotency_key === idempotencyKey) {
      return view(changeOrderId);
    }

    if (existing.status !== 'proposed') {
      throw new DomainError(409, 'already_decided',
        `change order is already ${existing.status} and cannot be changed`);
    }

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const decidedAt = now();

    await store.transaction(async (tx) => {
      const result = await store.decide(tx, {
        id: changeOrderId,
        status,
        decidedByPartyId: actorPartyId,
        decidedAt,
        idempotencyKey: idempotencyKey ?? null,
      });

      if (!result.applied) {
        // Lost the race: another writer decided between our read and this update.
        // If it was the same idempotent replay, commit a no-op and let the caller
        // read the settled state below; else 409.
        const fresh = await store.get(changeOrderId);
        if (idempotencyKey != null && fresh?.decision_idempotency_key === idempotencyKey) {
          return;
        }
        throw new DomainError(409, 'already_decided',
          `change order is already ${fresh?.status ?? 'decided'} and cannot be changed`);
      }

      await ledger.append(tx, {
        projectId: existing.project_id,
        type: status === 'approved' ? 'change_order_approved' : 'change_order_rejected',
        actorPartyId,
        occurredAt: decidedAt,
        payload: {
          changeOrderId,
          decidedBy: actorPartyId,
          costDeltaCents: existing.cost_delta_cents,
        },
      });

      // Only an approval moves the budget — and only the cost delta, never
      // scope/schedule/quality (FR5, FR8). UNIQUE(change_order_id) at the ledger
      // makes it exactly-once even if this transaction is replayed.
      if (status === 'approved') {
        await moveBudgetAbsorbingDuplicate(tx, () => ledger.recordBudgetEvent(tx, {
          projectId: existing.project_id,
          changeOrderId,
          deltaCents: existing.cost_delta_cents,
          actorPartyId,
          occurredAt: decidedAt,
        }));
      }
    });

    return view(changeOrderId); // one-screen view from committed state
  }

  // ---- the one-screen answer — FR6 ----------------------------------------
  // GET /change-orders/:id
  async function view(changeOrderId) {
    const c = await store.get(changeOrderId);
    if (!c) throw new DomainError(404, 'not_found', 'change order not found');

    // The budget read goes through the Ledger port's own connection (it owns the
    // schema — ADR-0006 §1), never the change_order tx. An unknown-to-ledger
    // project reads as a zero baseline, matching the in-memory port.
    const budget = (await ledger.currentBudget(c.project_id))
      ?? { baselineCents: 0, currentCents: 0 };
    // budget before→after for THIS change order. An approved CO has moved the
    // total by its delta, so its "before" is current − delta. A proposed CO has
    // moved nothing; we still surface what it *would* do if approved, clearly
    // labelled, so the one screen can answer "how much does this move it?".
    const moved = c.status === 'approved';
    const beforeCents = moved ? budget.currentCents - c.cost_delta_cents : budget.currentCents;
    const afterCents = moved ? budget.currentCents : budget.currentCents;

    return {
      id: c.id,
      projectId: c.project_id,
      decisionId: c.decision_id,
      title: c.title,
      costDeltaCents: c.cost_delta_cents,
      status: c.status,
      proposedBy: c.proposed_by_party_id,
      decidedBy: c.decided_by_party_id,
      createdAt: c.created_at,
      decidedAt: c.decided_at,
      scopeImpactNote: c.scope_impact_note,
      scheduleImpactDays: c.schedule_impact_days,
      scheduleImpactNote: c.schedule_impact_note,
      qualityFlag: !!c.quality_flag,
      qualityNote: c.quality_note,
      budget: {
        baselineCents: budget.baselineCents,
        currentCents: budget.currentCents,
        beforeCents,
        afterCents,
        movedCents: moved ? c.cost_delta_cents : 0,
        // Informational for a proposed CO: what the total would become if approved.
        projectedIfApprovedCents:
          c.status === 'proposed' ? budget.currentCents + c.cost_delta_cents : null,
      },
    };
  }

  // ---- list (chronological, FR7) ------------------------------------------
  // GET /projects/:id/change-orders
  async function list(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);
    const rows = await store.listByProject(projectId);
    return Promise.all(rows.map((r) => view(r.id)));
  }

  return { propose, decide, view, list };
}

export { DomainError };
