// Keyset cursors for tendering's lists (doc 11: `?cursor=…&limit=…`, response
// `next_cursor`, no offsets). A cursor is the last row's sort key, opaque on
// the wire (base64url JSON); a cursor that does not decode is 422.
import { ProblemError } from '../../../platform/errors.mjs';

export function encodeKey(key) {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

/** @param {(key: object) => boolean} valid shape check of the decoded key */
export function decodeKey(raw, valid) {
  if (!raw) return null;
  let key = null;
  try { key = JSON.parse(Buffer.from(String(raw), 'base64url').toString()); } catch { key = null; }
  if (!key || typeof key !== 'object' || !valid(key)) {
    throw new ProblemError('validation_failed', null, { errors: { cursor: 'not a cursor from this list' } });
  }
  return key;
}

export function clampLimit(raw, { fallback = 50, max = 200 } = {}) {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
