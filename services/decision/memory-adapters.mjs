// In-memory adapters for the Decision Log ports.
//
// These are the *reference implementations* the Postgres wiring (Slice 0/1/2)
// must behave like, and the backend the service tests run against. The ledger
// adapter drives the REAL hash-chain functions from `services/ledger`, so a test
// that appends a decision event and then verifies the chain is exercising the
// production maths — the ledger is not stubbed. The store adapter implements a
// genuine transaction with snapshot/rollback, so atomicity ("append fails → no
// projection row") is actually testable.
import { computeAppend, verifyChain } from '../ledger/hash-chain.mjs';

// ---- Ledger port -----------------------------------------------------------
// Mirrors `ledger.append_event(...)` (ADR-0002/0006): a per-project hash chain,
// appended inside the caller's transaction. append(tx, event) stages the event on
// the tx and returns the persisted audit event; it is only committed when the
// transaction commits (see the store below wiring `tx.onCommit`).
export function createMemoryLedger() {
  // projectId -> [appendedEvent...] (committed chain)
  const chains = new Map();

  function headOf(projectId) {
    const chain = chains.get(projectId);
    return chain && chain.length ? chain[chain.length - 1] : null;
  }

  return {
    async append(tx, { projectId, type, actorPartyId, occurredAt, payload }) {
      // Compute against the committed head PLUS anything already staged in this tx,
      // so two appends in one transaction chain correctly.
      const stagedForProject = tx.staged.filter((e) => e.projectId === projectId);
      const prev = stagedForProject.length
        ? stagedForProject[stagedForProject.length - 1].event
        : headOf(projectId);
      const appended = computeAppend(prev, { type, actorPartyId, occurredAt, payload });
      const auditEventId = `ae_${projectId}_${appended.seq}`;
      const record = { id: auditEventId, projectId, ...appended };
      tx.staged.push({ projectId, event: record });
      // On commit, move staged events into the committed chain.
      tx.onCommit(() => {
        const chain = chains.get(projectId) ?? [];
        chain.push(record);
        chains.set(projectId, chain);
      });
      return record;
    },
    // Test/inspection helpers (not part of the port contract the service uses).
    getChain(projectId) {
      return (chains.get(projectId) ?? []).map((e) => ({ ...e }));
    },
    verify(projectId) {
      return verifyChain(chains.get(projectId) ?? []);
    },
  };
}

// ---- Store port ------------------------------------------------------------
// The `decision` schema projection: decisions + append-only decision_revisions.
export function createMemoryStore() {
  const decisions = new Map(); // id -> { id, projectId, createdByPartyId, createdAt, currentRev, _order }
  const revisions = new Map(); // decisionId -> [ { id, decisionId, rev, title, body, revisedByPartyId, revisedAt, auditEventId } ]
  let order = 0;

  // A transaction over the in-memory maps. Mutations are staged and applied on
  // commit; a throw discards them (rollback), so a ledger failure mid-write
  // leaves no projection row behind — exactly the atomicity Postgres gives us.
  async function transaction(work) {
    const applied = [];
    const commitHooks = [];
    const tx = {
      staged: [], // ledger events staged this tx (see createMemoryLedger)
      onCommit(fn) { commitHooks.push(fn); },
      async insertDecision(row) {
        applied.push(() => decisions.set(row.id, { ...row, _order: order++ }));
      },
      async insertRevision(row) {
        applied.push(() => {
          const list = revisions.get(row.decisionId) ?? [];
          if (list.some((r) => r.rev === row.rev)) {
            // UNIQUE(decision_id, rev) — never two rows at the same rev.
            throw new Error(`duplicate revision rev ${row.rev} for decision ${row.decisionId}`);
          }
          list.push({ ...row });
          revisions.set(row.decisionId, list);
        });
      },
      async setCurrentRev(id, rev) {
        applied.push(() => {
          const d = decisions.get(id);
          if (d) d.currentRev = rev;
        });
      },
      async getDecisionForUpdate(id) {
        const d = decisions.get(id);
        return d ? { ...d } : null;
      },
      async maxRev(decisionId) {
        const list = revisions.get(decisionId) ?? [];
        return list.reduce((m, r) => Math.max(m, r.rev), 0);
      },
    };

    // Run the unit of work. If it throws, nothing is applied (rollback).
    await work(tx);
    // Commit: apply projection mutations, then fire ledger commit hooks.
    for (const fn of applied) fn();
    for (const fn of commitHooks) fn();
  }

  return {
    transaction,
    async getDecision(projectId, id) {
      const d = decisions.get(id);
      return d && d.projectId === projectId ? strip(d) : null;
    },
    async getDecisionById(id) {
      const d = decisions.get(id);
      return d ? strip(d) : null;
    },
    async listRevisions(decisionId) {
      return (revisions.get(decisionId) ?? []).map((r) => ({ ...r }));
    },
    async listDecisions(projectId) {
      return [...decisions.values()]
        .filter((d) => d.projectId === projectId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a._order - b._order))
        .map(strip);
    },
  };

  function strip(d) {
    const { _order, ...rest } = d;
    return { ...rest };
  }
}

// ---- Authz port ------------------------------------------------------------
// Stands in for Identity & Membership (Slice 2). Grant a party a set of actions
// per project; unknown → denied. The real service resolves these to membership
// role checks (ADR-0004); the port shape is identical.
export function createMemoryAuthz() {
  const grants = new Map(); // `${projectId}:${partyId}` -> Set(action)
  return {
    grant(projectId, partyId, actions) {
      const key = `${projectId}:${partyId}`;
      grants.set(key, new Set(actions));
    },
    async can(actorPartyId, action, projectId) {
      const set = grants.get(`${projectId}:${actorPartyId}`);
      return !!set && set.has(action);
    },
  };
}

// Convenience: a monotonic clock + deterministic id generator for tests.
export function createTestClock(startIso = '2026-08-26T09:00:00.000Z') {
  let t = Date.parse(startIso);
  return { now() { const v = new Date(t).toISOString(); t += 1000; return v; } };
}

export function createSeqIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}_${++n}`;
}
