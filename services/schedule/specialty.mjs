// Specialty catalog — list/create the pickable trade labels (LINA-306 item 6).
//
// A suggest catalog behind the plan grid's "Specialty" chip, deliberately like
// plan-template (LINA-241, ADR-0018) and unlike the rest of this service:
//
//   - NO ledger seam. A catalog carries no audit weight (ADR-0002); it is a list
//     of strings a picker offers, never linked to a stage or a version.
//   - NO project authorization. Specialties are per-USER and project-independent
//     — the ONLY gate is authentication (a caller with a session party).
//
// The acting party is ALWAYS the session (`actorPartyId`), NEVER the body — a
// created specialty names no owner (the insert stamps `owner_id` from the
// session), so a forged owner in a request is inert (ADR-0004).
//
// Resolution on read: system set ∪ this party's own, de-duped case-insensitively
// (a user row that shadows a system label collapses to one), sorted by label.
import { DomainError } from './ports.mjs';

const MAX_LABEL = 120;

export function createSpecialtyService({ store }) {
  if (!store) throw new Error('createSpecialtyService requires { store }');

  function requireActor(actorPartyId) {
    if (!actorPartyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
  }

  // GET — the caller's pickable list: system defaults ∪ their own creations. Pure
  // read; touches no project or stage. De-dupe is case-insensitive on the trimmed
  // label so a user's "electrical" never appears beside the system "Electrical".
  async function list(actorPartyId) {
    requireActor(actorPartyId);
    const rows = await store.listSpecialties(actorPartyId);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = r.label.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(shape(r));
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return { specialties: out };
  }

  // POST — create one on the fly, owned by the session party. Idempotent by the
  // partial unique index: re-creating a label the caller already has returns the
  // existing row rather than erroring, so the FE can fire-and-forget on commit of
  // a typed chip without racing itself. A label that only exists as a SYSTEM row
  // is not re-stored — it is already offered, so we hand that row straight back.
  async function create(actorPartyId, { label } = {}) {
    requireActor(actorPartyId);
    const clean = validateLabel(label);
    const row = await store.createUserSpecialty({ ownerId: actorPartyId, label: clean });
    return { specialty: shape(row) };
  }

  return { list, create, validateLabel };
}

function shape(row) {
  return {
    id: row.id,
    label: row.label,
    ownerScope: row.owner_scope,
    // `system` rows are shared; a `user` row is one this party created. The FE
    // uses this only to decide styling (a small "yours" hint), never to gate.
    mine: row.owner_scope === 'user',
  };
}

export function validateLabel(label) {
  if (typeof label !== 'string') {
    throw new DomainError(400, 'invalid_specialty', 'label must be a string');
  }
  const trimmed = label.trim();
  if (!trimmed) {
    throw new DomainError(400, 'invalid_specialty', 'a specialty needs a non-empty label');
  }
  if (trimmed.length > MAX_LABEL) {
    throw new DomainError(400, 'invalid_specialty', `a specialty label must be ≤ ${MAX_LABEL} chars`);
  }
  return trimmed;
}
