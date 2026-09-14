// Identity persistence port + an in-memory reference implementation.
//
// The Identity service is written against this PORT, not against Postgres. The
// Postgres adapter (./pg-store.mjs, schema in migrations/000{1,2}_identity.sql)
// wraps exactly these methods with schema-qualified `identity.*` SQL and the same
// invariants; it re-implements storage, never the service logic — the same
// discipline the ledger core follows (services/README.md). This in-memory store
// lets the service run and be adversarially tested with zero dependencies, and
// the uniqueness guards below mirror the DB constraints one-for-one, so a test
// that passes here is testing the real invariant.
//
// UNIT OF WORK (design §6, ADR-0006 §1): every identity mutation is a projection
// write PLUS a hash-chained ledger append that must commit together. So mutations
// run inside `transaction(fn)`, and the ledger append is part of that same unit
// (`tx.appendEvent`). In memory this is single-threaded (like the change_order
// reference store); the pg adapter opens a real Postgres transaction and calls
// `ledger.append(client, …)` on the same connection. Validation runs before any
// write so a rejected mutation leaves no partial state even without rollback.
//
// PORT — reads (no tx):
//   getParty(id) · upsertParty({id,displayName,email,role,language,setupComplete})
//   completeProfile({partyId,displayName,role,language})
//     -> {status:'ok',party} | {status:'already_setup'} | {status:'not_found'}
//   getProject(id) · getMembership(projectId, partyId) · listMemberships(projectId)
//   listProjectsForParty(partyId) — projects the party is a member of, each with members
//   getInvitationByTokenHash(hash) · listPendingInvitations(projectId)
//
// getParty(id) returns the identity.party row for a party UUID, used by GET /me
// to resolve session.partyId → { displayName, email, role }.
// PORT — transaction(fn) → fn(tx), where tx provides:
//   insertProject(row) · insertMembership(row) · insertInvitation(row)
//   markInvitationAccepted(id) · appendEvent(event) -> {seq, entryHash}
//
// All rows are returned as fresh shallow copies so callers cannot mutate stored
// state by holding a reference (the DB gives you copies too).

import { conflict, notFound } from './errors.mjs';

export function createMemoryStore({ ledger } = {}) {
  if (!ledger) throw new Error('createMemoryStore requires a ledger port');

  /** @type {Map<string, any>} */ const parties = new Map();
  /** @type {Map<string, any>} */ const projects = new Map();
  /** @type {Map<string, any>} */ const memberships = new Map(); // by membership id
  /** @type {Map<string, any>} */ const invitations = new Map(); // by invitation id
  /** @type {Map<string, string>} */ const invitationByToken = new Map(); // tokenHash -> id

  const copy = (row) => (row ? { ...row } : null);

  // ── Reads ───────────────────────────────────────────────────────────────────
  function getProject(id) {
    return copy(projects.get(id));
  }
  function getMembership(projectId, partyId) {
    for (const m of memberships.values()) {
      if (m.projectId === projectId && m.partyId === partyId) return copy(m);
    }
    return null;
  }
  function listMemberships(projectId) {
    return [...memberships.values()]
      .filter((m) => m.projectId === projectId)
      // owner before counterparty, then stable by joinedAt/id
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
      .map(copy);
  }
  // The portfolio read (GET /projects, ADR-0012 §A1): the projects where the
  // acting party is a MEMBER — owner or counterparty, draft or active — never all
  // org projects. Each returned row carries its (display-name-joined) members so
  // the service can shape the card's `members` without a second sweep.
  function listProjectsForParty(partyId) {
    const mine = new Set(
      [...memberships.values()]
        .filter((m) => m.partyId === partyId)
        .map((m) => m.projectId),
    );
    return [...projects.values()]
      .filter((p) => mine.has(p.id))
      .map((p) => ({
        ...copy(p),
        members: listMemberships(p.id).map((m) => ({
          ...m,
          // the in-memory party table is its own reference (upsertParty); join
          // its display name here, mirroring the pg store's p.display_name join.
          displayName: parties.get(m.partyId)?.displayName ?? null,
        })),
      }));
  }
  function getInvitationByTokenHash(tokenHash) {
    const id = invitationByToken.get(tokenHash);
    return id ? copy(invitations.get(id)) : null;
  }
  function listPendingInvitations(projectId) {
    return [...invitations.values()]
      .filter((i) => i.projectId === projectId && i.status === 'pending')
      .map(copy);
  }

  // ── Mutations (only reachable through transaction(fn)) ───────────────────────
  const tx = {
    insertProject(row) {
      if (projects.has(row.id)) throw conflict('project id already exists');
      projects.set(row.id, { ...row });
      return copy(projects.get(row.id));
    },

    insertMembership(row) {
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

    insertInvitation(row) {
      if (invitationByToken.has(row.tokenHash)) throw conflict('invitation token collision');
      // One pending invitation per project (the DB's partial UNIQUE index).
      for (const i of invitations.values()) {
        if (i.projectId === row.projectId && i.status === 'pending') {
          throw conflict('project already has a pending invitation');
        }
      }
      invitations.set(row.id, { ...row });
      invitationByToken.set(row.tokenHash, row.id);
      return copy(invitations.get(row.id));
    },

    markInvitationAccepted(id, acceptedAt) {
      const inv = invitations.get(id);
      if (!inv) throw notFound('invitation');
      if (inv.status !== 'pending') throw conflict('invitation is not pending');
      inv.status = 'accepted';
      inv.acceptedAt = acceptedAt ?? inv.acceptedAt ?? null;
      return copy(inv);
    },

    // Band B wizard mutations (ADR-0011). Both are projection edits that the
    // service only ever performs alongside a ledger append in the same unit —
    // never a silent update (the pg adapter's column-scoped grant enforces the
    // same separation).
    updateProjectOperatingModel(projectId, operatingModel) {
      const p = projects.get(projectId);
      if (!p) throw notFound('project');
      p.operatingModel = operatingModel;
      return copy(p);
    },

    updateProjectStatus(projectId, status) {
      const p = projects.get(projectId);
      if (!p) throw notFound('project');
      p.status = status;
      return copy(p);
    },

    // ADR-0016 §4: bind the homeowner to a GC-founded build, ONCE. Mirrors the pg
    // adapter's `WHERE owner_party_id IS NULL` guard so an already-owned build can
    // never have its owner re-pointed — owner_party_id moves NULL → value and never
    // again (a conflict, not a silent overwrite).
    stampOwnerParty(projectId, partyId) {
      const p = projects.get(projectId);
      if (!p) throw notFound('project');
      if (p.ownerPartyId != null) throw conflict('project already has an owner');
      p.ownerPartyId = partyId;
      return copy(p);
    },

    // Read-within-tx: accept must re-read the invite under the same unit so a
    // concurrent accept cannot double-spend it (the pg adapter uses SELECT … FOR
    // UPDATE / the status guard on markInvitationAccepted).
    getInvitationByTokenHash,

    appendEvent(event) {
      return ledger.appendEvent(event);
    },
  };

  function transaction(fn) {
    return fn(tx);
  }

  return {
    // reads
    getParty: (id) => copy(parties.get(id)),
    getPartyByEmail: (email) => {
      const wanted = String(email ?? '').toLowerCase();
      for (const p of parties.values()) {
        if (String(p.email ?? '').toLowerCase() === wanted) return copy(p);
      }
      return null;
    },
    upsertParty({ id, displayName, email, role, language, setupComplete }) {
      const existing = parties.get(id);
      const row = {
        id,
        displayName: displayName ?? existing?.displayName ?? null,
        email: email ?? existing?.email ?? null,
        role: role ?? existing?.role ?? 'contractor',
        language: language ?? existing?.language ?? null,
        setupComplete: setupComplete ?? existing?.setupComplete ?? false,
      };
      parties.set(id, row);
      return copy(row);
    },
    // Mirrors the pg adapter's conditional UPDATE one-for-one, including the
    // three-way outcome, so a service test written against this store is
    // testing the real invariant and not a friendlier fiction. Single-threaded
    // here, which is why the guard reads as a plain `if` — in Postgres the same
    // guard is `where setup_complete = false` and Postgres does the serialising.
    completeProfile({ partyId, displayName, role, language }) {
      const existing = parties.get(partyId);
      if (!existing) return { status: 'not_found' };
      if (existing.setupComplete) return { status: 'already_setup' };
      const row = { ...existing, displayName, role, language, setupComplete: true };
      parties.set(partyId, row);
      return { status: 'ok', party: copy(row) };
    },
    getProject,
    getMembership,
    listMemberships,
    listProjectsForParty,
    getInvitationByTokenHash,
    listPendingInvitations,
    // unit of work
    transaction,
  };
}
