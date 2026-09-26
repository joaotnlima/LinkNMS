// Transactional outbox (to-be docs 10, 11).
//
// `publishEvent` writes the envelope into platform.outbox USING THE CALLER'S
// CLIENT — the same transaction as the domain write and its ledger entry.
// That is the whole design: if the transaction rolls back, the event was never
// published; there is no "publish failed after commit" state to reconcile.
//
// The dispatcher is plumbing, deliberately dumb: poll undispatched rows in
// occurred_at order, hand each to every subscribed handler, mark dispatched.
// Delivery is at-least-once — a crash between deliver and mark re-delivers —
// so handlers MUST dedupe on event_id (doc 10). A handler that throws leaves
// the row undispatched; it will be retried on the next tick, and rows behind
// it wait (ordered delivery beats head-of-line optimisation at this stage).

const EVENT_TYPE = /^[a-z_]+\.[a-z_]+(\.[a-z_]+)+$/; // module.aggregate.happened
const SCOPE_TYPES = new Set(['project', 'contract', 'org_private', 'rfp_private']);

/** Validate the doc-10 envelope. Returns the envelope or throws. */
export function validateEnvelope(evt) {
  const fail = (why) => {
    throw new Error(`invalid event envelope: ${why}`);
  };
  if (!evt || typeof evt !== 'object') fail('not an object');
  if (typeof evt.event_id !== 'string' || evt.event_id.length < 32) fail('event_id must be a uuid');
  if (typeof evt.type !== 'string' || !EVENT_TYPE.test(evt.type)) {
    fail(`type ${JSON.stringify(evt.type)} is not module.aggregate.event`);
  }
  if (evt.version !== undefined && !Number.isInteger(evt.version)) fail('version must be an integer');
  if (!evt.actor || typeof evt.actor !== 'object') fail('actor is required');
  if (!evt.scope || typeof evt.scope !== 'object' || !SCOPE_TYPES.has(evt.scope.type)) {
    fail(`scope.type must be one of ${[...SCOPE_TYPES].join(', ')}`);
  }
  if (typeof evt.scope.id !== 'string') fail('scope.id is required');
  if (!evt.data || typeof evt.data !== 'object') fail('data is required (use {})');
  return evt;
}

/**
 * Insert the event into platform.outbox on `client` — which must be inside
 * the same transaction as the domain write this event describes.
 */
export async function publishEvent(client, evt) {
  validateEnvelope(evt);
  await client.query(
    `INSERT INTO platform.outbox (event_id, type, version, occurred_at, project_id, actor, scope, data)
     VALUES ($1, $2, $3, coalesce($4, now()), $5, $6, $7, $8)`,
    [
      evt.event_id,
      evt.type,
      evt.version ?? 1,
      evt.occurred_at ?? null,
      evt.project_id ?? null,
      JSON.stringify(evt.actor),
      JSON.stringify(evt.scope),
      JSON.stringify(evt.data),
    ],
  );
  return evt;
}

/**
 * Deliver pending events once. `handlers` is `{ [eventTypePrefix]: fn }` or a
 * list of `{ matches(type), handle(evt) }`. Returns how many were dispatched.
 *
 * Each row is marked dispatched only after every matching handler returned;
 * a throwing handler stops the batch so ordering is preserved on retry.
 */
export async function dispatchPending(pool, handlers, { limit = 100 } = {}) {
  const subs = normalizeHandlers(handlers);
  const { rows } = await pool.query(
    `SELECT event_id, type, version, occurred_at, project_id, actor, scope, data
       FROM platform.outbox
      WHERE dispatched_at IS NULL
      ORDER BY occurred_at, event_id
      LIMIT $1`,
    [limit],
  );
  let dispatched = 0;
  for (const evt of rows) {
    for (const sub of subs) {
      if (sub.matches(evt.type)) await sub.handle(evt);
    }
    await pool.query(
      'UPDATE platform.outbox SET dispatched_at = now() WHERE event_id = $1',
      [evt.event_id],
    );
    dispatched += 1;
  }
  return dispatched;
}

function normalizeHandlers(handlers) {
  if (Array.isArray(handlers)) return handlers;
  return Object.entries(handlers).map(([prefix, handle]) => ({
    matches: (type) => type === prefix || type.startsWith(`${prefix}.`),
    handle,
  }));
}

/**
 * Merge per-module consumer maps into one handler list WITHOUT clobbering.
 * Two modules may subscribe to the same type (planning.progress.reported
 * feeds both quality and contracting; planning.variation.* feeds planning's
 * digest rows AND collaboration's notifications) — an object spread would
 * silently drop all but the last, so maps become list entries instead.
 */
export function combineConsumers(...maps) {
  const subs = [];
  for (const map of maps) subs.push(...normalizeHandlers(map));
  return subs;
}

// Advisory lock key for the runtime dispatcher — one tick at a time across
// every serverless instance. dispatchPending itself is safe under overlap
// (handlers dedupe on event_id), the lock just stops routine double delivery.
const DISPATCH_LOCK = 0x4c4e4d53; // 'LNMS'

/**
 * One runtime dispatcher tick: take the advisory lock (skip the tick when
 * another instance holds it — its drain covers our rows), drain pending rows
 * batch by batch, unlock. Returns how many events were dispatched.
 */
export async function runDispatchTick(pool, handlers, { limit = 100, maxBatches = 10 } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [{ locked }] } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [DISPATCH_LOCK],
    );
    if (!locked) return 0;
    try {
      let total = 0;
      for (let i = 0; i < maxBatches; i += 1) {
        // Drain on the SAME client that holds the lock: one connection for
        // the whole tick, so a small pool can never deadlock between the
        // lock holder and the drain queries.
        const n = await dispatchPending(client, handlers, { limit });
        total += n;
        if (n < limit) break;
      }
      return total;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DISPATCH_LOCK]);
    }
  } finally {
    client.release();
  }
}
