// Pure wire shape for one ledger entry (the AuditEntry of
// cowork/documentation/api/v2/openapi.yaml). Split from the store so the
// row → body mapping — and the V7 redaction contract — is unit-testable
// without a database.
//
// V7 (doc 04): an entry the viewer is not in scope for is REDACTED — its
// payload is withheld and `redacted: true` — but it keeps its seq, type and
// hashes so the chain the client verifies stays complete. The store decides
// visibility in SQL (it needs cross-schema joins) and hands us a row whose
// `payload` is already null when out of scope; this function only shapes it.

/**
 * @param {{
 *   seq: string|number, occurred_at: string, category: string, type: string,
 *   actor_person_id: string|null, actor_org_id: string|null, actor_org_role: string|null,
 *   object_type: string, object_id: string,
 *   entry_hash: string, prev_hash: string|null,
 *   payload: unknown, redacted: boolean
 * }} row
 * @returns AuditEntry
 */
export function toAuditEntry(row) {
  const entry = {
    // seq is a bigint — pg returns it as a string; the API models it int64.
    seq: Number(row.seq),
    occurred_at: row.occurred_at,
    category: row.category,
    type: row.type,
    actor: {
      person_id: row.actor_person_id,
      org_id: row.actor_org_id,
      org_role: row.actor_org_role,
    },
    object_type: row.object_type,
    object_id: row.object_id,
    redacted: Boolean(row.redacted),
    entry_hash: row.entry_hash,
    prev_hash: row.prev_hash,
  };
  // "absent when redacted" (schema): only attach payload when in scope. The
  // store nulls the column for out-of-scope entries, so this is the one place
  // the withholding is enforced regardless of what the row carries.
  if (!entry.redacted && row.payload != null) entry.payload = row.payload;
  return entry;
}
