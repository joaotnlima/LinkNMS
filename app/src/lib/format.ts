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
