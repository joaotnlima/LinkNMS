// Presentation helpers. Money is integer cents on the wire (design §6); we only
// format for display — never compute budget/status here.
import type { Role } from './types';

/**
 * THE money formatter (one for the whole app). LinkNMS builds are priced in
 * euros (Portugal first), so a figure prints with `€` — "€180,000" — exactly as
 * the tendering surfaces always did (tendering-view `formatMoney`, rfp-link
 * `formatEuro`, which now delegate here). Grouping is the English comma style
 * the rest of the UI copy is written in, so a budget and a bid read the same
 * wherever they appear. A non-EUR currency prints its ISO code ("USD 50").
 * Negative amounts keep a leading '-'.
 */
export function formatCents(
  cents: number,
  { currency = 'EUR', fractionDigits = 0 }: { currency?: string; fractionDigits?: number } = {},
): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const symbol = currency === 'EUR' ? '€' : `${currency} `;
  return `${sign}${symbol}${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** Whole euros — "€250,000". */
export function money(cents: number): string {
  return formatCents(cents);
}

/** Euros and cents — "€250,000.00". */
export function moneyPrecise(cents: number): string {
  return formatCents(cents, { fractionDigits: 2 });
}

export function delta(cents: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (cents > 0) return { text: `+${money(cents)}`, dir: 'up' };
  if (cents < 0) return { text: `−${money(-cents)}`, dir: 'down' };
  return { text: money(0), dir: 'flat' };
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

/**
 * The short attribution label beside a name. `subcontractor` arrived with
 * migration 0009 / ADR-0011 §4 and is labelled distinctly rather than folded into
 * "GC": on a record whose promise is "who decided this", calling a specialty
 * contractor the general contractor is a wrong answer to the product's only
 * question. "Trade" rather than "Sub" — it is what the trades call themselves and
 * it does not read as a diminutive of the GC.
 */
export function roleLabel(role: Role): string {
  return role === 'owner' ? 'Owner' : role === 'subcontractor' ? 'Trade' : 'GC';
}

/**
 * The inverse direction: a human-typed currency amount → integer cents
 * (LINA-57). The one parsing counterpart to the formatters above, and the only
 * place a typed budget becomes a number.
 *
 * It REJECTS rather than rounds. `parseFloat('250,000.999')` yields 250 and
 * `Math.round` would turn a fat-fingered third decimal into a silently
 * different baseline — and the baseline is the figure every later cost claim is
 * measured against, so "close enough" is not a thing it can be. Rejecting sends
 * the user back to a field they can see; rounding sends them to an argument six
 * months later.
 *
 * @throws Error with a message intended for direct display in the form.
 */
export function parseAmountToCents(
  raw: string,
  { allowNegative = false, label = 'amount' }: { allowNegative?: boolean; label?: string } = {},
): number {
  // Spaces, a currency sign and thousands separators are how people actually
  // type money; everything past that must be exact.
  const cleaned = raw.trim().replace(/[\s,]/g, '').replace(/^([-+]?)[$€]/, '$1');
  const pattern = allowNegative ? /^[-+]?\d+(\.\d{1,2})?$/ : /^\+?\d+(\.\d{1,2})?$/;
  if (!pattern.test(cleaned)) {
    throw new Error(
      allowNegative
        ? `Enter the ${label} as an amount with at most two decimals, e.g. 4200 or -1250.50`
        : `Enter the ${label} as a positive amount with at most two decimals, e.g. 250000 or 250000.00`,
    );
  }
  const negative = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace(/^[-+]/, '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`That ${label} is too large to record precisely.`);
  }
  return negative ? -cents : cents;
}

/** A project baseline: never negative. */
export function parseBudgetToCents(raw: string): number {
  return parseAmountToCents(raw, { label: 'baseline budget' });
}

/** A change order's cost impact: may reduce the budget as well as increase it. */
export function parseCostDeltaToCents(raw: string): number {
  return parseAmountToCents(raw, { allowNegative: true, label: 'cost impact' });
}
