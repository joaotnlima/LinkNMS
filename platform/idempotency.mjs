// Idempotency-Key handling for POST commands (to-be doc 11).
//
// The reservation lives in platform.idempotency_key and is written on the
// SAME client (same transaction) as the command's domain write:
//   - command succeeds  → reservation + result committed together
//   - command throws    → transaction rolls back, reservation evaporates,
//                         the key is cleanly retryable
//   - concurrent replay → the second INSERT blocks on the first's uncommitted
//                         PK row; after the first commits it becomes a replay.
//
// Schedule deltas do NOT come through here — `client_change_id` plays this
// role there (doc 11), inside the planning module.
import { createHash } from 'node:crypto';

import { ProblemError } from './errors.mjs';

/** Canonical request hash: stable across key order. */
export function requestHash(body) {
  return createHash('sha256').update(canonical(body ?? null)).digest();
}

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/**
 * Run `fn` under an idempotency reservation. Returns `{ status, body,
 * replayed }`. `fn` must perform the command on the SAME `client` and return
 * `{ status, body }`.
 */
export async function withIdempotency(client, { key, caller, operationId, body }, fn) {
  const hash = requestHash(body);
  const inserted = await client.query(
    `INSERT INTO platform.idempotency_key (key, caller, operation_id, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key, caller, operation_id) DO NOTHING
     RETURNING key`,
    [key, caller, operationId, hash],
  );

  if (inserted.rows.length === 0) {
    const { rows } = await client.query(
      `SELECT request_hash, response_status, response_body, completed_at
         FROM platform.idempotency_key
        WHERE key = $1 AND caller = $2 AND operation_id = $3`,
      [key, caller, operationId],
    );
    const prior = rows[0];
    if (!prior) {
      // The reserving transaction rolled back between our INSERT and SELECT.
      throw new ProblemError('version_conflict', 'retry: the previous attempt with this Idempotency-Key just failed');
    }
    if (!hash.equals(prior.request_hash)) {
      throw new ProblemError('idempotency_mismatch');
    }
    if (prior.completed_at === null) {
      throw new ProblemError('version_conflict', 'a request with this Idempotency-Key is still in progress');
    }
    return { status: prior.response_status, body: prior.response_body, replayed: true };
  }

  const result = await fn();
  await client.query(
    `UPDATE platform.idempotency_key
        SET response_status = $4, response_body = $5, completed_at = now()
      WHERE key = $1 AND caller = $2 AND operation_id = $3`,
    [key, caller, operationId, result.status, JSON.stringify(result.body ?? null)],
  );
  return { ...result, replayed: false };
}
