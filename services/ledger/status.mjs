// Four-pillar project status — the FR9 derivation (design §5).
//
// Pure functions over already-summed inputs, so this is unit-testable without a
// database and the Postgres adapter just feeds it numbers. Every pillar returns
// colour PLUS a label AND an icon name — never colour alone (FR9 accessibility).
//
// Hard rules from the design:
//   - Cost is the only quantified pillar; it always exposes the numbers.
//   - Time = Σ schedule_impact_days on APPROVED change orders. It NEVER claims
//     "on track vs baseline" — R0 holds no schedule baseline.
//   - Scope/Quality are qualitative signals and NEVER move the budget.

// Icon names are semantic tokens the UI maps to glyphs; the point is that the
// signal survives with colour stripped out.
const ICON = {
  ok: 'check-circle',
  info: 'info',
  warn: 'alert-triangle',
  over: 'alert-octagon',
};

function centsToLabel(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Cost pillar (FR5/FR9): green at/under baseline, amber when over by ≤ threshold%,
// red beyond it. Always carries the numbers.
export function costPillar({ baselineCents, currentCents, amberThresholdPct = 10 }) {
  const deltaCents = currentCents - baselineCents;
  const overPct = baselineCents > 0 ? (deltaCents / baselineCents) * 100 : (deltaCents > 0 ? Infinity : 0);

  let status;
  let label;
  if (deltaCents <= 0) {
    status = 'green';
    label = deltaCents === 0
      ? `On budget — ${centsToLabel(currentCents)}`
      : `${centsToLabel(-deltaCents)} under budget`;
  } else if (overPct <= amberThresholdPct) {
    status = 'amber';
    label = `${centsToLabel(deltaCents)} over (${overPct.toFixed(1)}%)`;
  } else {
    status = 'red';
    label = `${centsToLabel(deltaCents)} over (${overPct === Infinity ? '∞' : overPct.toFixed(1) + '%'})`;
  }

  return {
    pillar: 'cost',
    status,
    label,
    icon: status === 'green' ? ICON.ok : status === 'amber' ? ICON.warn : ICON.over,
    baselineCents,
    currentCents,
    deltaCents,
  };
}

// Time pillar (FR8/FR9): purely the sum of approved schedule-impact days. Never
// framed against a baseline we do not hold.
export function timePillar({ approvedScheduleImpactDays = 0 }) {
  const days = approvedScheduleImpactDays;
  const status = days === 0 ? 'green' : 'amber';
  return {
    pillar: 'time',
    status,
    label: days === 0 ? 'No schedule changes recorded' : `Changes added ~${days} day${days === 1 ? '' : 's'}`,
    icon: days === 0 ? ICON.ok : ICON.info,
    approvedScheduleImpactDays: days,
  };
}

// Scope pillar (FR8/FR9): amber if any OPEN (proposed) change order carries a
// scope note — a scope change is on the table but not yet decided.
export function scopePillar({ openScopeNoteCount = 0 }) {
  const status = openScopeNoteCount === 0 ? 'green' : 'amber';
  return {
    pillar: 'scope',
    status,
    label: openScopeNoteCount === 0
      ? 'No open scope changes'
      : `${openScopeNoteCount} open scope change${openScopeNoteCount === 1 ? '' : 's'}`,
    icon: openScopeNoteCount === 0 ? ICON.ok : ICON.warn,
    openScopeNoteCount,
  };
}

// Quality pillar (FR8/FR9): amber if any APPROVED change order was flagged for
// quality impact.
export function qualityPillar({ approvedQualityFlagCount = 0 }) {
  const status = approvedQualityFlagCount === 0 ? 'green' : 'amber';
  return {
    pillar: 'quality',
    status,
    label: approvedQualityFlagCount === 0
      ? 'No quality concerns flagged'
      : `${approvedQualityFlagCount} approved change${approvedQualityFlagCount === 1 ? '' : 's'} flagged`,
    icon: approvedQualityFlagCount === 0 ? ICON.ok : ICON.warn,
    approvedQualityFlagCount,
  };
}

// The whole four-pillar panel in one call (design §5). `inputs` are already-summed
// figures the ledger produces; keeping this pure makes FR9 unit-testable.
export function deriveStatus(inputs) {
  return {
    cost: costPillar(inputs),
    time: timePillar(inputs),
    scope: scopePillar(inputs),
    quality: qualityPillar(inputs),
  };
}
