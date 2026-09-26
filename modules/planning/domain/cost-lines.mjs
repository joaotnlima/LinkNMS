// Cost lines (the BoQ rows hanging off plan rows) — pure, doc 05 §8, D-27.
//
// The lines LIVE in contracting.boq_item (the BoQ is attached to where the
// work is); the operations are the Planning tag, so the maths and the wire
// projection are here. A line amount is round(quantity × unit_price_cents),
// half-up, exactly as SQL round() computes it (checks.sql §2) — integer
// maths, never floats (fractional-cents gotcha).

/** round(quantity × unit_price_cents), half-up; both sides non-negative. */
export function lineAmountCents(quantity, unitPriceCents) {
  const [int, frac = ''] = String(quantity).split('.');
  const milli = BigInt(int || '0') * 1000n + BigInt((frac + '000').slice(0, 3));
  const product = milli * BigInt(unitPriceCents);
  return Number((product + 500n) / 1000n);
}

/**
 * Doc 04 V2/V5: a line is visible to the parties of ITS contract; an owner
 * estimate (contract_id NULL) to the org that holds it. Lines the viewer may
 * not see are OMITTED entirely, never nulled.
 */
export function costLineVisibleTo(line, viewerOrgId, contracts) {
  if (!line.contractId) return line.estimateOwnerOrgId === viewerOrgId;
  const contract = contracts.get(line.contractId);
  if (!contract) return false;
  return viewerOrgId === contract.clientOrgId || viewerOrgId === contract.supplierOrgId;
}

/** api/v2 #/components/schemas/CostLine. */
export function costLineBody(line) {
  return {
    id: line.id,
    task_id: line.taskId,
    contract_id: line.contractId ?? null,
    code: line.code,
    description: line.description,
    unit: line.unit,
    quantity: String(line.quantity),
    unit_price: { amount_cents: Number(line.unitPriceCents), currency: 'EUR' },
    line_total: { amount_cents: lineAmountCents(line.quantity, line.unitPriceCents), currency: 'EUR' },
    material_spec: line.materialSpec ?? undefined,
    superseded: line.supersededByChangeOrderId != null,
  };
}

/** Σ round(q×p) of a task's LIVE lines for one contract, in cents. */
export function taskContractTotalCents(lines, taskId, contractId) {
  let total = 0;
  for (const l of lines) {
    if (l.taskId !== taskId || l.contractId !== contractId) continue;
    if (l.supersededByChangeOrderId != null) continue;
    total += lineAmountCents(l.quantity, l.unitPriceCents);
  }
  return total;
}
