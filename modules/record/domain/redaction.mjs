// V7 ledger scope redaction (doc 04) — pure projection, no I/O.
//
// The record surface answers "who changed what, when, and how much it moved
// the budget" for one project. Every project participant may READ the ledger,
// but an entry carries the SCOPE of the change it records (project / contract /
// org_private / rfp_private), and a participant without access to that scope
// must not learn its content — only that a scoped change happened, so the hash
// chain still verifies end to end (invariant V7).
//
// The store computes one `visible` boolean per row (the scope-visibility join
// lives in SQL, next to the data). These functions shape the wire body from
// that flag, so the redaction rule is a pure, unit-testable transform with no
// session and no database.
//
// Redaction rule (doc 04 V7): an out-of-scope entry keeps ONLY
//   seq, occurred_at, category, entry_hash, prev_hash
// and nothing else — not the type, not the actor, not the object, not the
// payload — because each of those can itself disclose the fact being withheld
// (a `contracting.change_order.approved` on a contract you cannot see already
// leaks that the contract exists and moved). In-scope entries carry the full
// payload and actor.

/**
 * Shape one raw `record.audit_event` row (already carrying a `visible` flag and
 * hex-encoded hashes from the store) into the OpenAPI `AuditEntry` wire object.
 *
 * @param {{
 *   seq: number|string, occurred_at: Date|string, category: string,
 *   type: string, actor_person_id: string|null, actor_org_id: string|null,
 *   actor_org_role: string|null, object_type: string, object_id: string,
 *   payload: object, entry_hash: string, prev_hash: string|null,
 *   visible: boolean
 * }} row
 * @returns {object} AuditEntry — redacted (5 fields + `redacted:true`) or full.
 */
export function toAuditEntry(row) {
  const base = {
    seq: Number(row.seq),
    occurred_at: toIso(row.occurred_at),
    category: row.category,
    entry_hash: row.entry_hash,
    prev_hash: row.prev_hash ?? null,
  };
  if (!row.visible) return { ...base, redacted: true };
  return {
    ...base,
    type: row.type,
    actor: {
      person_id: row.actor_person_id ?? null,
      org_id: row.actor_org_id ?? null,
      org_role: row.actor_org_role ?? null,
    },
    object_type: row.object_type,
    object_id: row.object_id,
    payload: row.payload,
    redacted: false,
  };
}

/** Project a page of raw rows to the `listRecord` body. */
export function toRecordPage(rows, nextCursor) {
  return { items: rows.map(toAuditEntry), next_cursor: nextCursor ?? null };
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  // pg already gives a Date for timestamptz; a string (tests) passes through.
  return typeof value === 'string' ? value : new Date(value).toISOString();
}
