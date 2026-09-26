// The comparison matrix — pure (no I/O), doc 06 §lanes + schema Comparison:
// lines × proposals with unit price, median and missing lines, plus duration
// per packaged row. Issuer-only, behind `org:money:view` (16 §5) — money
// never reaches this code for anyone else.
import { money } from './wire.mjs';

/**
 * @param items      rfp_item rows of the CURRENT package version
 * @param proposals  proposal rows (status submitted/shortlisted/awarded)
 * @param lines      proposal_line rows of those proposals (non-variant)
 * @param rows       proposal_row rows of those proposals (for durations)
 * @returns          {items, durations} of #/components/schemas/Comparison
 */
export function comparisonMatrix({ items, proposals, lines, rows }) {
  const priced = new Map(); // rfp_item_id → Map(proposal_id → unit_price_cents)
  for (const line of lines) {
    if (line.is_variant || !line.rfp_item_id) continue;
    if (!priced.has(line.rfp_item_id)) priced.set(line.rfp_item_id, new Map());
    priced.get(line.rfp_item_id).set(line.proposal_id, Number(line.unit_price_cents));
  }

  const itemsOut = items.map((item) => {
    const byProposal = priced.get(item.id) ?? new Map();
    const prices = {};
    for (const [proposalId, cents] of byProposal) prices[proposalId] = money(cents);
    const missingIn = proposals.filter((p) => !byProposal.has(p.id)).map((p) => p.id);
    const med = median([...byProposal.values()]);
    return {
      rfp_item_id: item.id,
      description: item.description,
      unit: item.unit,
      quantity: String(item.quantity),
      prices,
      ...(med != null ? { median: money(med) } : {}),
      missing_in: missingIn,
    };
  });

  // Duration per packaged row: a bidder's answer for a packaged task is the
  // proposal row that references it.
  const byPackagedTask = new Map(); // packaged_task_id → { proposal_id: duration }
  for (const row of rows) {
    if (!row.packaged_task_id || row.duration_wd == null) continue;
    if (!byPackagedTask.has(row.packaged_task_id)) byPackagedTask.set(row.packaged_task_id, {});
    byPackagedTask.get(row.packaged_task_id)[row.proposal_id] = row.duration_wd;
  }
  const durations = [...byPackagedTask.entries()].map(([taskId, byProposal]) => ({
    packaged_task_id: taskId,
    by_proposal: byProposal,
  }));

  return { items: itemsOut, durations };
}

/** Lower-median in integer cents (deterministic, no fractional cent). */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** How many current-package items a proposal left unpriced (lane chip). */
export function missingLineCount(items, proposalLines) {
  const pricedItems = new Set(
    proposalLines.filter((l) => !l.is_variant && l.rfp_item_id).map((l) => l.rfp_item_id),
  );
  return items.filter((i) => !pricedItems.has(i.id)).length;
}
