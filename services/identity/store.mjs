// Identity persistence port + an in-memory reference implementation.
//
// The Identity service is written against this PORT, not against Postgres. The
// Postgres implementation (migrations/001_identity.sql defines the schema) wraps
// exactly these methods with schema-qualified `identity.*` SQL and the same
// invariants; it re-implements storage, never the service logic — the same
// discipline the ledger core follows (services/README.md). This in-memory store
// lets the service run and be adversarially tested with zero dependencies, and
// the uniqueness guards below mirror the DB constraints one-for-one so a test
// that passes here is testing the real invariant.
//
// PORT (every method a Postgres store must also provide):
//   getParty(id) -> party | null
//   upsertParty({ id, displayName }) -> party
//   createProject(row) -> project              // row: {id,name,ownerPartyId,baselineBudgetCents,createdAt}
//   getProject(id) -> project | null
//   getMembership(projectId, partyId) -> membership | null
//   listMemberships(projectId) -> membership[]
//   createMembership(row) -> membership        // enforces UNIQUE(project,role) & UNIQUE(project,party)
//   createInvitation(row) -> invitation
//   getInvitationByTokenHash(tokenHash) -> invitation | null
//   markInvitationAccepted(id) -> invitation
//
// All rows are returned as fresh shallow copies so callers cannot mutate stored
// state by holding a reference (the DB gives you copies too).

import { conflict, notFound } from './errors.mjs';

export function createMemoryStore() {
  /** @type {Map<string, any>} */ const parties = new Map();
  /** @type {Map<string, any>} */ const projects = new Map();
  /** @type {Map<string, any>} */ const memberships = new Map(); // by membership id
  /** @type {Map<string, any>} */ const invitations = new Map(); // by invitation id
  /** @type {Map<string, string>} */ const invitationByToken = new Map(); // tokenHash -> id

  const copy = (row) => (row ? { ...row } : null);

  return {
    getParty(id) {
      return copy(parties.get(id));
    },

    upsertParty({ id, displayName }) {
      const existing = parties.get(id);
      const row = { id, displayName: displayName ?? existing?.displayName ?? null };
      parties.set(id, row);
      return copy(row);
    },

    createProject(row) {
      if (projects.has(row.id)) throw conflict('project id already exists');
      projects.set(row.id, { ...row });
      return copy(projects.get(row.id));
    },

    getProject(id) {
      return copy(projects.get(id));
    },

    getMembership(projectId, partyId) {
      for (const m of memberships.values()) {
        if (m.projectId === projectId && m.partyId === partyId) return copy(m);
      }
      return null;
    },

    listMemberships(projectId) {
      return [...memberships.values()]
        .filter((m) => m.projectId === projectId)
        .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
        .map(copy);
    },

    createMembership(row) {
      // Mirror the DB's two unique constraints (design §3 integrity rules):
      //   UNIQUE(project_id, role)   — exactly one owner, one counterparty in R0
      //   UNIQUE(project_id, party)  — a party joins a project at most once
      for (const m of memberships.values()) {
        if (m.projectId === row.projectId && m.role === row.role) {
          throw conflict(`project already has a ${row.role}`);
        }
        if (m.projectId === row.projectId && m.partyId === row.partyId) {
          throw conflict('party is already a member of this project');
        }
      }
      memberships.set(row.id, { ...row });
      return copy(memberships.get(row.id));
    },

    createInvitation(row) {
      if (invitationByToken.has(row.tokenHash)) throw conflict('invitation token collision');
      invitations.set(row.id, { ...row });
      invitationByToken.set(row.tokenHash, row.id);
      return copy(invitations.get(row.id));
    },

    getInvitationByTokenHash(tokenHash) {
      const id = invitationByToken.get(tokenHash);
      return id ? copy(invitations.get(id)) : null;
    },

    // Only pending invitations for this project (used to stop a second pending
    // counterparty invite before one is accepted — the DB backs this with the
    // membership UNIQUE, but rejecting early gives a cleaner 409).
    listPendingInvitations(projectId) {
      return [...invitations.values()]
        .filter((i) => i.projectId === projectId && i.status === 'pending')
        .map(copy);
    },

    markInvitationAccepted(id) {
      const inv = invitations.get(id);
      if (!inv) throw notFound('invitation');
      inv.status = 'accepted';
      return copy(inv);
    },
  };
}
