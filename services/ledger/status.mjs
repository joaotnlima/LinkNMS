// Four-pillar project status — the M14 derivation (pen "S · M14 · The record,
// live"; ADR-0015, superseding the R0 design §5 keys).
//
// Pure functions over already-summed inputs, so this is unit-testable without a
// database and the Postgres adapter just feeds it numbers. Every pillar returns
// colour PLUS a label AND an icon name — never colour alone (FR9 accessibility).
//
// The four pillars are SCHEDULE · BUDGET · SCOPE · SAFETY (ADR-0015 §1):
//   - BUDGET (was `cost`) is the only quantified pillar; it always exposes the
//     numbers — current vs baseline, never a spent figure the ledger lacks (§3).
//   - SCHEDULE (was `time`) = Σ schedule_impact_days on APPROVED change orders.
//     It NEVER claims "on track vs baseline" — R0 holds no schedule baseline.
//   - SCOPE is a qualitative signal and NEVER moves the budget.
//   - SAFETY has NO backing data: it is a STATIC "not tracked yet", status
//     `none` — never a green "no incidents", which would assert a safety record
//     that does not exist (§2). The `quality` pillar is gone with the R0 keys.

// Icon names are semantic tokens the UI maps to glyphs; the point is that the
// signal survives with colour stripped out.
const ICON = {
  ok: 'check-circle',
  info: 'info',
  warn: 'alert-triangle',
  over: 'alert-octagon',
  shield: 'shield',
};

function centsToLabel(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Budget pillar (was `cost`; FR5/FR9): green at/under baseline, amber when over
// by ≤ threshold%, red beyond it. Always carries the numbers — current vs
// baseline. It never reports a spent figure: the ledger holds the contract
// budget (baseline + Σ approved change orders), not money paid out (ADR-0015 §3).
export function budgetPillar({ baselineCents, currentCents, amberThresholdPct = 10 }) {
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
    pillar: 'budget',
    status,
    label,
    icon: status === 'green' ? ICON.ok : status === 'amber' ? ICON.warn : ICON.over,
    baselineCents,
    currentCents,
    deltaCents,
  };
}

// Schedule pillar (was `time`; FR8/FR9): purely the sum of approved
// schedule-impact days. Never framed against a baseline we do not hold.
export function schedulePillar({ approvedScheduleImpactDays = 0 }) {
  const days = approvedScheduleImpactDays;
  const status = days === 0 ? 'green' : 'amber';
  return {
    pillar: 'schedule',
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

// Safety pillar (ADR-0015 §2): STATIC. There is no incidents/safety surface and
// no safety data in the ledger, so this reports "not tracked yet" at status
// `none` — muted, and deliberately NOT a green "no incidents", which would be
// the record asserting a safety history it does not have. It takes no input; it
// becomes a real derivation only when an incidents surface exists.
export function safetyPillar() {
  return {
    pillar: 'safety',
    status: 'none',
    label: 'Not tracked yet',
    icon: ICON.shield,
    tracked: false,
  };
}

// The whole four-pillar panel in one call (pen M14; ADR-0015 §1). `inputs` are
// already-summed figures the ledger produces; keeping this pure makes FR9
// unit-testable. Order matches the pen: SCHEDULE · BUDGET · SCOPE · SAFETY.
export function deriveStatus(inputs) {
  return {
    schedule: schedulePillar(inputs),
    budget: budgetPillar(inputs),
    scope: scopePillar(inputs),
    safety: safetyPillar(),
  };
}
