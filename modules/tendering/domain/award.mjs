// What an award tells the plan (D-43) — pure.
//
// The baseline of an awarded branch is taken AT AWARD, with the start and the
// duration of the winning proposal. Planning owns the plan and must never read
// tendering tables, so `tendering.rfp.awarded` carries the facts it needs:
//   root_task_ids   — the tendered rows (the branch roots);
//   supplier_org_id — the winner, who takes the roots (doc 06 §Award);
//   start           — the winning proposal's start (`summary_start`: typed on
//                     an emailed answer, derived from the bidder's dated rows on
//                     a platform proposal); null when the bid carries none (a
//                     summary/public bid) — planning then keeps the rows' dates;
//   duration_wd     — the winning proposal's duration in working days
//                     (`summary_duration_wd`), null when absent.
// There is no RFP work window in the model to fall back on (tendering.rfp has
// none), so a bid without a start leaves the plan's own dates in place.
//
// PRD-05 F-12 (D-39, D-48): a DESIGN award also tells planning what the task
// must hand over —
//   purpose      — 'design' | 'execution';
//   deliverables — for a design RFP, the list items of its "Brief &
//                  deliverables" text (scope_text); [] otherwise. Planning
//                  seeds them as required deliverables of the first root.

const MAX_DELIVERABLES = 50;
const DELIVERABLE_MAX = 300;
const LIST_ITEM = /^\s*(?:[-*•‣–]|\d{1,3}[.)])\s+(.+?)\s*$/;

/**
 * The deliverables a design brief lists: one per bullet or numbered line
 * (`- `, `* `, `• `, `1.`, `1)`). Prose is not a list — it seeds nothing; the
 * client side adds deliverables on the task instead.
 */
export function deliverablesFromScope(scopeText) {
  const out = [];
  const seen = new Set();
  for (const line of String(scopeText ?? '').split(/\r?\n/)) {
    const m = LIST_ITEM.exec(line);
    if (!m) continue;
    const title = m[1].slice(0, DELIVERABLE_MAX);
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length === MAX_DELIVERABLES) break;
  }
  return out;
}

/** @returns {{root_task_ids: string[], supplier_org_id: string|null, start: string|null, duration_wd: number|null, purpose: string, deliverables: string[]}} */
export function awardedPlanFacts(rfp, winner) {
  const purpose = rfp?.purpose === 'design' ? 'design' : 'execution';
  return {
    purpose,
    deliverables: purpose === 'design' ? deliverablesFromScope(rfp?.scope_text) : [],
    root_task_ids: [...(rfp?.root_task_ids ?? [])],
    supplier_org_id: winner?.bidder_org_id ?? null,
    start: isoDate(winner?.summary_start),
    duration_wd: Number.isInteger(winner?.summary_duration_wd) && winner.summary_duration_wd > 0
      ? winner.summary_duration_wd
      : null,
  };
}

function isoDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // node-postgres parses a DATE at LOCAL midnight; read it back locally.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
