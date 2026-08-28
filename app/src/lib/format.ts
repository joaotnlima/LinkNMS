// Presentation helpers. Money is integer cents on the wire (design §6); we only
// format for display — never compute budget/status here.

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function moneyPrecise(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function delta(cents: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (cents > 0) return { text: `+${money(cents)}`, dir: 'up' };
  if (cents < 0) return { text: `−${money(-cents)}`, dir: 'down' };
  return { text: '$0', dir: 'flat' };
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

export function roleLabel(role: 'owner' | 'counterparty'): string {
  return role === 'owner' ? 'Owner' : 'GC';
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
  const cleaned = raw.trim().replace(/[\s,]/g, '').replace(/^([-+]?)\$/, '$1');
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
