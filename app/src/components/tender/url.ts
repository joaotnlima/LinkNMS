// The tender workspace mirrors its place into the address bar (`?rfp=`,
// `?compare=`) so a deep link is shareable and a reload lands where it left.

/**
 * Mirror the surface's place into the address bar — `?rfp=` (which tender is
 * open) and `?compare=` (which bids the drill-down is over) — using the raw
 * History API so the URL is shareable and reload-safe without a Next navigation
 * (which would re-run this force-dynamic route and revalidate away inbox state).
 */
export function mirrorUrl(rfpId: string | null, compare: string | null): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (rfpId) params.set('rfp', rfpId); else params.delete('rfp');
  if (compare) params.set('compare', compare); else params.delete('compare');
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}
