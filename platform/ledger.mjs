// Ledger client — the ONE way a module writes the legal-grade history.
//
// `record.append_event()` (db/v2/0001) is the sole writer: it takes the
// per-project advisory lock, assigns the monotonic seq and extends the hash
// chain. This wrapper exists so every call site passes the SAME transaction
// client as its domain write (invariant §6.4: no entry means no change), and
// so the argument order lives in exactly one place.
//
// The ledger is not the outbox (doc 02 rule 4): a ledgered change ALSO
// publishes its event via platform/outbox.mjs, in the same transaction.

const CATEGORIES = new Set([
  'project', 'tendering', 'contracting', 'planning',
  'quality', 'documents', 'collaboration', 'identity',
]);
const CHANNELS = new Set(['ui', 'mcp', 'api', 'import', 'system']);

/**
 * Append one entry to record.audit_event inside the caller's transaction.
 *
 * @param client  pg client already inside BEGIN…COMMIT with the domain write
 * @param entry   { projectId, occurredAt?, actor: {personId?, orgId?, orgRole?},
 *                  category, type, scope: {type, id}, object: {type, id},
 *                  payload, channel? }
 * @returns the assigned seq (bigint as string)
 */
export async function appendAuditEvent(client, entry) {
  const {
    projectId, occurredAt, actor = {}, category, type,
    scope, object, payload, channel = 'ui',
  } = entry;
  if (!projectId) throw new Error('ledger: projectId is required');
  if (!CATEGORIES.has(category)) throw new Error(`ledger: unknown category ${category}`);
  if (!CHANNELS.has(channel)) throw new Error(`ledger: unknown channel ${channel}`);
  if (!scope?.type || !scope?.id) throw new Error('ledger: scope {type, id} is required');
  if (!object?.type || !object?.id) throw new Error('ledger: object {type, id} is required');
  if (!payload || typeof payload !== 'object') throw new Error('ledger: payload is required');

  const { rows } = await client.query(
    `SELECT record.append_event(
       $1::uuid, coalesce($2::timestamptz, now()), $3::uuid, $4::uuid, $5,
       $6, $7, $8, $9::uuid, $10, $11::uuid, $12::jsonb, $13) AS seq`,
    [
      projectId, occurredAt ?? null,
      actor.personId ?? null, actor.orgId ?? null, actor.orgRole ?? null,
      category, type, scope.type, scope.id,
      object.type, object.id, JSON.stringify(payload), channel,
    ],
  );
  return rows[0].seq;
}
