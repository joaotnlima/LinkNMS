// Tender defaults — pure (PRD-04 X-7; audit nit: the app used to pick them).
//
// A draft created without a bids-due date (e.g. "Ask for a proposal" from a
// company profile) gets one here: two weeks out (14 calendar days), 18:00 on
// the building site's clock — Portugal, Europe/Lisbon (summer time included).
// The issuer changes it before publishing; the server is the only place the
// default lives.

export const DEFAULT_BIDS_DUE_DAYS = 14;
export const DEFAULT_BIDS_DUE_HOUR = 18;
const ZONE = 'Europe/Lisbon';

/** Minutes the zone is ahead of UTC at instant `t`. */
function zoneOffsetMinutes(t) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(t).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - t.getTime()) / 60000);
}

/** @returns {string} ISO instant: now + 14 days, at 18:00 Lisbon time */
export function defaultSubmissionDeadline(now = new Date()) {
  const day = new Date(now.getTime() + DEFAULT_BIDS_DUE_DAYS * 86400000);
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(day).split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, DEFAULT_BIDS_DUE_HOUR));
  return new Date(guess.getTime() - zoneOffsetMinutes(guess) * 60000).toISOString();
}
