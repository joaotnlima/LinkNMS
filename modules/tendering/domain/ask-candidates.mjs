// "Ask for a proposal" from a company profile (PRD-04 X-6, X-7) — pure. Which
// of a build's tasks a company is offered for, in what order, and where it
// would land. The plan rows come from planning's task port, the company's
// specialty family from the directory's company port, the governing RFP of
// each row from tendering's own per-task procurement projection.
//
//   specialty_match — the row's specialty_code is in the company's family
//                     (each code, its parent and its children — PRD-03 R-1);
//   target          — `draft` (the row's governing RFP is a draft: add the
//                     company there), `new` (no live tender: a new draft
//                     prefilled from the row), `locked` (out for bids already:
//                     adding a bidder there would send a link at once, and
//                     nothing is sent from this dialog).
// Matching rows first, then the plan's outline order. Milestones are not work.

export const LOCKED_REASON = 'Out for bids already — add bidders from the task panel.';

/** Where the company would go for a row, from its governing RFP. */
export function askTargetOf(rfp) {
  if (!rfp || rfp.status === 'cancelled') return { kind: 'new' };
  if (rfp.status === 'draft') return { kind: 'draft', rfp_id: rfp.rfp_id };
  return { kind: 'locked', reason: LOCKED_REASON };
}

/**
 * @param {{ id, code, name, kind, specialty_code }[]} tasks  outline order
 * @param {string[]} family     the company's specialty family
 * @param {object[]} procurement TaskProcurement items (governing RFP per row)
 * @returns AskCandidate[]
 */
export function askCandidates({ tasks, family, procurement }) {
  const codes = new Set(family ?? []);
  const byTask = new Map((procurement ?? []).map((p) => [p.task_id, p]));
  return tasks
    .filter((t) => t.kind !== 'milestone')
    .map((t, i) => {
      const p = byTask.get(t.id) ?? null;
      return {
        i,
        body: {
          task_id: t.id,
          code: t.code,
          name: t.name,
          specialty_code: t.specialty_code ?? null,
          specialty_match: Boolean(t.specialty_code && codes.has(t.specialty_code)),
          rfp: p ? { id: p.rfp_id, title: p.title, status: p.status, invited_count: p.invited_count } : null,
          target: askTargetOf(p),
        },
      };
    })
    .sort((a, b) => Number(b.body.specialty_match) - Number(a.body.specialty_match) || a.i - b.i)
    .map(({ body }) => body);
}
