// Fractional position keys (doc 05 §2): ordering among siblings never needs
// renumbering, so two people reordering different rows never conflict.
// Keys are strings over a fixed alphabet, compared lexicographically; a key
// never ends in the zero digit (that would leave no room before it).
// `midpoint` is the standard fractional-indexing algorithm (Greenspan).
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A key strictly between `a` and `b`; null on either side means the open end.
 */
export function keyBetween(a, b) {
  return midpoint(a ?? '', b ?? null);
}

function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`position: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  if (a.slice(-1) === '0' || (b && b.slice(-1) === '0')) {
    throw new Error('position: keys must not end in 0');
  }
  if (b) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null && b.length ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** n ordered keys strictly between `a` and `b` (for pasting several rows). */
export function keysBetween(a, b, n) {
  const out = [];
  let prev = a ?? null;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, b ?? null);
    out.push(prev);
  }
  return out;
}
