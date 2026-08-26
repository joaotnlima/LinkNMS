// Ledger & Budget service — the hash chain (ADR-0002).
//
// This is the trust anchor. It is deliberately storage-agnostic: pure functions
// over plain event objects, so the exact same code that computes a chain when we
// append also re-computes it when we verify. One serializer, one hashing rule,
// used on both sides — that is what makes tamper-evidence real instead of
// aspirational (ADR-0002 §2, design §9). Postgres persistence and the
// `ledger.append_event(...)` function (ADR-0006 §1) wrap these functions; they
// never re-implement the maths.
import { createHash } from 'node:crypto';

// The fixed genesis link. seq 1's prev_hash is this constant, so the very first
// event is already anchored and a deletion of seq 1 is detectable.
export const GENESIS_HASH = '0'.repeat(64);

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Canonical JSON — the load-bearing detail (ADR-0002 consequences, design §9).
// Verification only works if serialization is byte-stable across append and
// verify. Rules:
//   - object keys sorted lexicographically, recursively;
//   - no incidental whitespace;
//   - numbers must be finite integers (money is integer cents everywhere — never
//     floats — so we refuse anything that could serialize ambiguously);
//   - undefined is not representable; null is explicit.
// Anything outside these rules throws rather than silently producing a hash that
// can't be reproduced later.
export function canonicalJson(value) {
  return serialize(value);
}

function serialize(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
    if (!Number.isInteger(v)) {
      // Floats can serialize differently across runtimes/locales. The domain
      // uses integer cents; a float here is a bug, not a value to guess at.
      throw new TypeError('canonicalJson: non-integer number (money must be integer cents)');
    }
    return String(v);
  }
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (t === 'undefined') throw new TypeError('canonicalJson: undefined is not serializable');
  if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(v[k])).join(',') + '}';
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}

// The hash of an event's meaning — its type, actor, server timestamp, and
// payload. Changing any of these changes payload_hash and therefore the whole
// downstream chain.
export function payloadHash({ type, actorPartyId, occurredAt, payload }) {
  return sha256Hex(
    canonicalJson({
      type,
      actorPartyId: actorPartyId ?? null,
      occurredAt,
      payload: payload ?? null,
    }),
  );
}

// entry_hash = sha256(prev_hash || payload_hash). This is the link: it binds
// each event to the exact prior event, so a silent edit or deletion anywhere
// breaks every link after it.
export function entryHash(prevHash, pHash) {
  return sha256Hex(prevHash + pHash);
}

// Given the previous event (or null for genesis) and the new event's meaning,
// compute the fields that get persisted. Pure — no I/O, no clock; occurredAt is
// passed in by the caller (server-authoritative upstream).
export function computeAppend(prevEvent, event) {
  const seq = prevEvent ? prevEvent.seq + 1 : 1;
  const prevHash = prevEvent ? prevEvent.entryHash : GENESIS_HASH;
  const pHash = payloadHash(event);
  return {
    seq,
    type: event.type,
    actorPartyId: event.actorPartyId ?? null,
    occurredAt: event.occurredAt,
    payload: event.payload ?? null,
    payloadHash: pHash,
    prevHash,
    entryHash: entryHash(prevHash, pHash),
  };
}

// Verify a full chain (events in seq order). Returns
//   { verified: true }                         when the chain is intact, or
//   { verified: false, firstBrokenSeq, reason } at the first broken link.
// It recomputes payload_hash, prev_hash and entry_hash from the stored event
// content, so ANY of these breaks it: a mutated payload, a forged hash, a
// deleted middle event (seq gap), a reordered event, or a broken prev link.
export function verifyChain(events) {
  let prevEntryHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expectedSeq = i + 1;

    if (e.seq !== expectedSeq) {
      return broken(e.seq ?? expectedSeq, `expected seq ${expectedSeq}, got ${e.seq}`);
    }
    if (e.prevHash !== prevEntryHash) {
      return broken(e.seq, 'prev_hash does not match previous entry_hash');
    }
    const pHash = payloadHash(e);
    if (e.payloadHash !== pHash) {
      return broken(e.seq, 'payload_hash does not match event content (payload tampered)');
    }
    const expectedEntry = entryHash(e.prevHash, pHash);
    if (e.entryHash !== expectedEntry) {
      return broken(e.seq, 'entry_hash does not match prev_hash || payload_hash');
    }
    prevEntryHash = e.entryHash;
  }
  return { verified: true };
}

function broken(firstBrokenSeq, reason) {
  return { verified: false, firstBrokenSeq, reason };
}

// The current head hash of a chain — used as the audit ETag (ADR-0006 §3) and as
// the value we could externally notarize later (ADR-0002 alternatives).
export function headHash(events) {
  return events.length ? events[events.length - 1].entryHash : GENESIS_HASH;
}
