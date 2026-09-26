// Money-flow domain (phase 5) — pure (no I/O), to-be docs 06, 09, 11.
//
// State machines are the doc-09 tables verbatim:
//   change order:  draft → submitted → approved | rejected;
//                  draft/submitted → withdrawn (proposer only)
//   measurement:   draft → submitted → approved | disputed; disputed → submitted
//   payment:       expected → declared_paid → confirmed;
//                  declared_paid → disputed → declared_paid
// plus the wire projections (openapi.yaml ChangeOrder / Measurement /
// PaymentRecord / Financials / CashFlow) and the ONE money arithmetic:
// a line amount is round(quantity × unit_price_cents), half-up, exactly as
// SQL round() computes it in checks.sql §2 — integer maths, never floats.

/** action → { from: [...], to } — doc 09 §Change order. */
const CO_TRANSITIONS = Object.freeze({
  submit: { from: ['draft'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  reject: { from: ['submitted'], to: 'rejected' },
  withdraw: { from: ['draft', 'submitted'], to: 'withdrawn' },
});

/** doc 09 §Measurement. `submit` covers the disputed → submitted revision. */
const MEASUREMENT_TRANSITIONS = Object.freeze({
  submit: { from: ['draft', 'disputed'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  dispute: { from: ['submitted'], to: 'disputed' },
});

/** doc 09 §Payment record. `declare` covers the disputed re-declare. */
const PAYMENT_TRANSITIONS = Object.freeze({
  declare: { from: ['expected', 'disputed'], to: 'declared_paid' },
  confirm: { from: ['declared_paid'], to: 'confirmed' },
  dispute: { from: ['declared_paid'], to: 'disputed' },
});

function run(table, status, action) {
  const rule = table[action];
  if (!rule) return { ok: false, reason: `unknown action: ${action}` };
  if (!rule.from.includes(status)) {
    return { ok: false, reason: `cannot ${action} a ${status} one` };
  }
  return { ok: true, to: rule.to };
}

export const changeOrderTransition = (status, action) => run(CO_TRANSITIONS, status, action);
export const measurementTransition = (status, action) => run(MEASUREMENT_TRANSITIONS, status, action);
export const paymentTransition = (status, action) => run(PAYMENT_TRANSITIONS, status, action);

// ── money arithmetic (checks.sql §2, integer maths) ─────────────────────────

/**
 * round(quantity × unit_price_cents) with SQL round() semantics (half-up;
 * quantities and prices are non-negative by CHECK). `quantity` is the wire
 * string (^\d+(\.\d{1,3})?$) or pg numeric text.
 */
export function lineAmountCents(quantity, unitPriceCents) {
  const [int, frac = ''] = String(quantity).split('.');
  const milli = BigInt(int || '0') * 1000n + BigInt((frac + '000').slice(0, 3));
  const product = milli * BigInt(unitPriceCents);
  return Number((product + 500n) / 1000n);
}

/** retention = round(gross × retention_bp / 10000), half-up. */
export function retentionCents(grossCents, retentionBp) {
  const product = BigInt(grossCents) * BigInt(retentionBp);
  return Number((product + 5000n) / 10000n);
}

export function money(cents) {
  return { amount_cents: Number(cents ?? 0), currency: 'EUR' };
}

// ── wire projections ─────────────────────────────────────────────────────────

/**
 * api/v2 #/components/schemas/ChangeOrder for a PARTY of its contract.
 * `bundle` = { changeOrder (contracting.change_order row), lines, time }.
 */
export function changeOrderBody({ changeOrder, lines, time }) {
  return {
    id: changeOrder.id,
    contract_id: changeOrder.contract_id,
    number: changeOrder.number,
    kind: changeOrder.kind,
    reason: changeOrder.reason,
    amount_delta: money(changeOrder.amount_delta_cents),
    lines: (lines ?? []).map((l) => ({
      op: l.op,
      boq_item_id: l.boq_item_id ?? undefined,
      new_line: l.new_line ?? undefined,
    })),
    time: (time ?? []).map((t) => ({
      task_id: t.task_id,
      new_baseline_start: dateOnly(t.new_baseline_start),
      new_baseline_finish: dateOnly(t.new_baseline_finish),
    })),
    linked_change_order_id: changeOrder.linked_change_order_id ?? undefined,
    from_variation_ids: changeOrder.from_variation_ids ?? [],
    proposed_by: { org_id: changeOrder.proposed_by_org_id, person_id: changeOrder.proposed_by_person_id },
    ...(changeOrder.decided_by_org_id
      ? {
          decided_by: { org_id: changeOrder.decided_by_org_id, person_id: changeOrder.decided_by_person_id },
          decided_at: iso(changeOrder.decided_at),
        }
      : {}),
    status: changeOrder.status,
    version: changeOrder.version,
  };
}

/**
 * The ancestor-party projection (architect ruling 11): existence only —
 * amounts and lines ABSENT, never null (§6.5).
 */
export function changeOrderExistenceBody(changeOrder) {
  return {
    id: changeOrder.id,
    contract_id: changeOrder.contract_id,
    status: changeOrder.status,
    _visibility: { commercial: false, reason: 'linked change order of a contract you are not party to' },
  };
}

/**
 * api/v2 Measurement. `bundle` = { measurement, lines: [{boq_item_id,
 * description, unit_price_cents, quantity_this_period, cumulative_quantity}] }.
 */
export function measurementBody({ measurement, lines }) {
  return {
    ...(measurement.id ? { id: measurement.id } : {}),
    contract_id: measurement.contract_id,
    period: measurement.period,
    status: measurement.status,
    lines: (lines ?? []).map((l) => ({
      boq_item_id: l.boq_item_id,
      description: l.description ?? undefined,
      quantity_this_period: String(l.quantity_this_period),
      ...(l.cumulative_quantity != null ? { cumulative_quantity: String(l.cumulative_quantity) } : {}),
      amount: money(lineAmountCents(l.quantity_this_period, l.unit_price_cents ?? 0)),
    })),
    gross: money(measurement.gross_cents),
    retention: money(measurement.retention_cents),
    net: money(measurement.net_cents),
  };
}

export function paymentBody(payment) {
  return {
    id: payment.id,
    contract_id: payment.contract_id,
    measurement_id: payment.measurement_id ?? undefined,
    milestone_label: payment.milestone_label ?? undefined,
    amount: money(payment.amount_cents),
    due_date: dateOnly(payment.due_date),
    status: payment.status,
    declared_paid_at: iso(payment.declared_paid_at),
    confirmed_at: iso(payment.confirmed_at),
  };
}

/** api/v2 Financials — every field Money (doc 06 §money view). */
export function financialsBody({ valueCents, approvedChangesCents, measuredCents, retentionHeldCents, paidCents, outstandingCents }) {
  return {
    value: money(valueCents),
    approved_changes: money(approvedChangesCents),
    measured: money(measuredCents),
    retention_held: money(retentionHeldCents),
    paid: money(paidCents),
    outstanding: money(outstandingCents),
  };
}

/** api/v2 CashFlow — owner-level payments only (V3: sub prices never). */
export function cashFlowBody({ from, to, items }) {
  let total = 0;
  for (const i of items) total += Number(i.amount_cents);
  return {
    from: from ?? undefined,
    to: to ?? undefined,
    items: items.map((i) => ({
      due_date: dateOnly(i.due_date),
      contract_id: i.contract_id,
      supplier: i.supplier,
      amount: money(i.amount_cents),
      status: i.status,
    })),
    total: money(total),
  };
}

function iso(value) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnly(value) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
