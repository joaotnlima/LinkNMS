// Ledger & Budget — the Postgres adapter (ADR-0002, ADR-0006 §1/§3, design §4-5).
//
// This is the production trust anchor: it wraps the pure hash-chain core
// (./hash-chain.mjs) around Postgres. The split that keeps tamper-evidence real:
//
//   * payload_hash — sha256(canonical_json(meaning)) — is computed HERE in JS by
//     the single shared serializer. It is the drift-sensitive maths and is NEVER
//     re-implemented in SQL.
//   * seq / prev_hash / entry_hash are constructed by ledger.append_event(...) in
//     the database, under a per-project advisory lock, so concurrent appends can
//     never fork the chain (ADR-0006 §1). The entry-link sha256(prev||payload) is
//     a trivial ascii-hex concat; verifyChain (JS) recomputes it from stored
//     content on every read, so a DB-level tamper is caught regardless.
//
// occurred_at is the subtle correctness point: it is normalised to a canonical
// ISO-8601 millisecond-UTC string BEFORE hashing and read back byte-identically
// via to_char, so a full round-trip through a timestamptz column reproduces the
// exact hash input. Anything else yields verify false-positives.
//
// Derived reads (budget, four-pillar status, chain-verify, audit ETag) are cached
// with TTL + invalidation on every append (ADR-0006 §3).
import {
  computeAppend,
  payloadHash,
  verifyChain,
  headHash,
  GENESIS_HASH,
} from './hash-chain.mjs';
import { deriveStatus } from './status.mjs';
import { createLedgerCache } from './cache.mjs';
import { withTransaction, getPool } from './db.mjs';

// Raised when a budget_event already exists for a change order
// (UNIQUE(change_order_id)) — mirrors the in-memory port so callers stay
// exactly-once (a double-approve is an idempotent no-op, never a double move).
export class LedgerBudgetConflict extends Error {}

const PG_UNIQUE_VIOLATION = '23505';

// Canonical hash input for occurred_at. Always millisecond-precision UTC.
function canonicalOccurredAt(occurredAt) {
  const iso = new Date(occurredAt).toISOString();
  if (Number.isNaN(Date.parse(iso))) {
    throw new TypeError(`ledger append: invalid occurredAt ${occurredAt}`);
  }
  return iso;
}

// Read the full chain for a project in seq order, shaped exactly as verifyChain
// expects. occurred_at comes back in the same canonical ISO string that was
// hashed, so verify recomputes identical payload/entry hashes.
const READ_CHAIN_SQL = `
  select seq,
         type,
         actor_party_id as "actorPartyId",
         to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "occurredAt",
         payload,
         payload_hash as "payloadHash",
         prev_hash    as "prevHash",
         entry_hash   as "entryHash"
    from ledger.audit_event
   where project_id = $1
   order by seq`;

export function createPgLedger({ pool = getPool(), cache = createLedgerCache() } = {}) {
  async function readChain(client, projectId) {
    const { rows } = await client.query(READ_CHAIN_SQL, [projectId]);
    // seq comes back as a string (bigint); normalise to number for the JS core.
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
  }

  // The single write path. Runs on the caller's transaction `client` so the
  // projection write and this append commit together (ADR-0006 §1). Returns the
  // persisted event shape plus the new audit_event id.
  async function append(client, { projectId, type, actorPartyId, occurredAt, payload }) {
    const occurredIso = canonicalOccurredAt(occurredAt);
    const pHash = payloadHash({
      type,
      actorPartyId: actorPartyId ?? null,
      occurredAt: occurredIso,
      payload: payload ?? null,
    });

    const { rows } = await client.query(
      `select id, seq, entry_hash as "entryHash"
         from ledger.append_event($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        projectId,
        type,
        actorPartyId ?? null,
        occurredIso,
        payload == null ? null : JSON.stringify(payload),
        pHash,
      ],
    );
    const row = rows[0];
    cache.invalidate(projectId);
    return {
      id: row.id,
      projectId,
      seq: Number(row.seq),
      type,
      actorPartyId: actorPartyId ?? null,
      occurredAt: occurredIso,
      payload: payload ?? null,
      payloadHash: pHash,
      entryHash: row.entryHash,
    };
  }

  // Move the budget exactly once for a change order. budget_event is inserted
  // FIRST so UNIQUE(change_order_id) rejects a double-approve before any second
  // budget_moved event is appended; then the audit event is chained and linked
  // back. All on the caller's tx.
  async function recordBudgetEvent(client, { projectId, changeOrderId, deltaCents, actorPartyId, occurredAt }) {
    let budgetEventId;
    try {
      const inserted = await client.query(
        `insert into ledger.budget_event (project_id, change_order_id, delta_cents)
         values ($1, $2, $3)
         returning id`,
        [projectId, changeOrderId, deltaCents],
      );
      budgetEventId = inserted.rows[0].id;
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw new LedgerBudgetConflict(`budget_event already exists for ${changeOrderId}`);
      }
      throw err;
    }

    const event = await append(client, {
      projectId,
      type: 'budget_moved',
      actorPartyId,
      occurredAt,
      payload: { changeOrderId, deltaCents },
    });

    await client.query(
      `update ledger.budget_event set audit_event_id = $1 where id = $2`,
      [event.id, budgetEventId],
    );

    return { budgetEventId, changeOrderId, deltaCents };
  }

  // ── Derived reads (cached) ────────────────────────────────────────────────

  // Current budget = baseline (from the project_created genesis payload) + Σ
  // budget_event delta_cents. Fully ledger-side: no cross-schema read (design §5).
  async function currentBudget(projectId) {
    const { value } = await cache.getOrCompute(projectId, 'budget', async () => {
      const client = await pool.connect();
      try {
        const baseRes = await client.query(
          `select (payload ->> 'baselineBudgetCents')::bigint as baseline
             from ledger.audit_event
            where project_id = $1 and type = 'project_created'
            order by seq limit 1`,
          [projectId],
        );
        if (baseRes.rowCount === 0) return null; // unknown project to the ledger
        const baselineCents = Number(baseRes.rows[0].baseline ?? 0);

        const sumRes = await client.query(
          `select coalesce(sum(delta_cents), 0) as approved
             from ledger.budget_event where project_id = $1`,
          [projectId],
        );
        const approvedTotalCents = Number(sumRes.rows[0].approved);
        return { baselineCents, approvedTotalCents, currentCents: baselineCents + approvedTotalCents };
      } finally {
        client.release();
      }
    });
    return value;
  }

  // Identity-port shape (GET /projects/:id budget block).
  async function budgetSummary(projectId) {
    const b = await currentBudget(projectId);
    if (!b) return null;
    return { baselineBudgetCents: b.baselineCents, currentBudgetCents: b.currentCents };
  }

  // Fold the chain into the summed inputs the four-pillar status needs — all from
  // the ledger's own events (approval/proposal payloads carry the scope/schedule/
  // quality fields), so status stays ledger-side (design §5).
  function statusInputsFromChain(events) {
    let approvedScheduleImpactDays = 0;
    let approvedQualityFlagCount = 0;
    const openScopeByCo = new Map(); // changeOrderId -> has open scope note

    for (const e of events) {
      const p = e.payload ?? {};
      if (e.type === 'change_order_proposed') {
        if (p.changeOrderId != null) {
          openScopeByCo.set(p.changeOrderId, Boolean(p.scopeImpactNote));
        }
      } else if (e.type === 'change_order_approved') {
        approvedScheduleImpactDays += Number(p.scheduleImpactDays ?? 0);
        if (p.qualityFlag) approvedQualityFlagCount += 1;
        if (p.changeOrderId != null) openScopeByCo.delete(p.changeOrderId); // no longer open
      } else if (e.type === 'change_order_rejected') {
        if (p.changeOrderId != null) openScopeByCo.delete(p.changeOrderId);
      }
    }
    let openScopeNoteCount = 0;
    for (const hasNote of openScopeByCo.values()) if (hasNote) openScopeNoteCount += 1;
    return { approvedScheduleImpactDays, approvedQualityFlagCount, openScopeNoteCount };
  }

  async function status(projectId, { amberThresholdPct = 10 } = {}) {
    const { value } = await cache.getOrCompute(projectId, 'status', async () => {
      const client = await pool.connect();
      try {
        const events = await readChain(client, projectId);
        if (events.length === 0) return null;
        const genesis = events.find((e) => e.type === 'project_created');
        const baselineCents = Number(genesis?.payload?.baselineBudgetCents ?? 0);
        const approvedTotalCents = events
          .filter((e) => e.type === 'budget_moved')
          .reduce((s, e) => s + Number(e.payload?.deltaCents ?? 0), 0);
        const inputs = statusInputsFromChain(events);
        return deriveStatus({
          baselineCents,
          currentCents: baselineCents + approvedTotalCents,
          amberThresholdPct,
          ...inputs,
        });
      } finally {
        client.release();
      }
    });
    return value;
  }

  // chain-verify, cached. Recomputes the whole chain from stored content.
  async function verify(projectId) {
    const { value } = await cache.getOrCompute(projectId, 'verify', async () => {
      const client = await pool.connect();
      try {
        return verifyChain(await readChain(client, projectId));
      } finally {
        client.release();
      }
    });
    return value;
  }

  // GET /projects/:id/audit — events in seq order + chain-verify result, with an
  // ETag = head entry_hash for cheap 304s (ADR-0006 §3). Pass the request's
  // If-None-Match to short-circuit an unchanged ledger.
  async function getAudit(projectId, { ifNoneMatch } = {}) {
    const { value } = await cache.getOrCompute(projectId, 'audit', async () => {
      const client = await pool.connect();
      try {
        const events = await readChain(client, projectId);
        const etag = `"${headHash(events)}"`;
        return { etag, events, verify: verifyChain(events) };
      } finally {
        client.release();
      }
    });

    if (ifNoneMatch && ifNoneMatch === value.etag) {
      return { status: 304, etag: value.etag };
    }
    return { status: 200, etag: value.etag, events: value.events, verify: value.verify };
  }

  // appendEvent — the identity-port convenience: append on its own transaction and
  // return just the chain coordinates.
  async function appendEvent({ projectId, type, actorPartyId, occurredAt, payload }) {
    return withTransaction(async (client) => {
      const e = await append(client, { projectId, type, actorPartyId, occurredAt, payload });
      return { seq: e.seq, entryHash: e.entryHash };
    }, pool);
  }

  return {
    append,
    appendEvent,
    recordBudgetEvent,
    currentBudget,
    budgetSummary,
    status,
    verify,
    getAudit,
    // test/diagnostic surface (not part of the consumed ports)
    _chain: (projectId) => withTransaction((c) => readChain(c, projectId), pool),
    _cache: cache,
    GENESIS_HASH,
  };
}
