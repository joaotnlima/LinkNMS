// The Ledger & Budget interface, as Identity consumes it (ADR-0003, ADR-0006 §1).
//
// Identity NEVER reads the ledger's or anyone else's schema. Two things it needs
// from Ledger it gets only through this typed in-process interface (swappable for
// HTTP later — the extraction seam):
//
//   1. appendEvent(...)      — Identity's own mutations (project created, GC
//                              invited/joined) are ledgered events. In Postgres
//                              this call and the identity projection write COMMIT
//                              in ONE cross-schema transaction (ADR-0006 §1); the
//                              append itself goes through ledger.append_event(...)
//                              (SECURITY DEFINER), so hash-chain construction lives
//                              in exactly one place. Identity holds no INSERT on
//                              audit_event.
//   2. budgetSummary(id)     — the GET /projects/:id budget block. Baseline enters
//                              the ledger via the project_created event payload, so
//                              the whole summary (baseline + Σ approved deltas) is
//                              computed on the ledger side. Identity does NOT sum
//                              budget_event rows — that would be a cross-schema
//                              read. It just asks.
//
// This file defines the PORT contract and ships a reference in-memory adapter that
// wraps the REAL trust anchor (../ledger/hash-chain.mjs). It exists so this slice
// runs and is testable end-to-end before the Postgres ledger lands; the production
// adapter implements the same two methods over `ledger.append_event` + the budget
// view.
//
// PORT:
//   appendEvent({ projectId, type, actorPartyId, occurredAt, payload }) -> { seq, entryHash }
//   budgetSummary(projectId) -> { baselineBudgetCents, currentBudgetCents }

import { computeAppend, verifyChain } from '../ledger/hash-chain.mjs';

export function createMemoryLedger() {
  /** @type {Map<string, any[]>} */ const chains = new Map(); // projectId -> events[]

  return {
    appendEvent({ projectId, type, actorPartyId, occurredAt, payload }) {
      const events = chains.get(projectId) ?? [];
      const prev = events.length ? events[events.length - 1] : null;
      const appended = computeAppend(prev, { type, actorPartyId, occurredAt, payload });
      events.push(appended);
      chains.set(projectId, events);
      return { seq: appended.seq, entryHash: appended.entryHash };
    },

    budgetSummary(projectId) {
      const events = chains.get(projectId);
      if (!events || events.length === 0) return null; // unknown project to the ledger
      // Baseline is carried in the genesis (project_created) event payload; in R0
      // Slice 2 there are no budget events yet, so current == baseline. Slice 4
      // adds Σ(approved cost deltas) here — still entirely ledger-side.
      const genesis = events.find((e) => e.type === 'project_created');
      const baseline = genesis?.payload?.baselineBudgetCents ?? 0;
      const delta = events
        .filter((e) => e.type === 'budget_event')
        .reduce((sum, e) => sum + (e.payload?.deltaCents ?? 0), 0);
      return { baselineBudgetCents: baseline, currentBudgetCents: baseline + delta };
    },

    // Test/diagnostic surface — not part of the port Identity uses. Lets the
    // adversarial tests assert Identity's mutations really chained.
    _chain(projectId) {
      return (chains.get(projectId) ?? []).map((e) => ({ ...e }));
    },
    _verify(projectId) {
      return verifyChain(chains.get(projectId) ?? []);
    },
  };
}
