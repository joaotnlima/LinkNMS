// Tendering lifecycles — pure (no I/O), to-be docs 06, 09 verbatim.
//
// Two state machines:
//   rfp:      draft → published (`publish`) → closed (`deadline`/`close_early`)
//             → awarded (`award`); draft/published/closed → cancelled.
//   proposal: invited → draft → submitted → shortlisted → awarded | declined;
//             invited → submitted (issuer records an emailed answer);
//             submitted/shortlisted → withdrawn (bidder, before award).
// The award guard (doc 09 §RFP: proposal submitted/shortlisted, RFP closed or
// all invitees responded) lives in the use case — it needs the other lanes.

/** action → { from: [...], to } — rfp (doc 09 §RFP). */
const RFP_TRANSITIONS = Object.freeze({
  publish: { from: ['draft'], to: 'published' },
  close: { from: ['published'], to: 'closed' },
  award: { from: ['closed'], to: 'awarded' },
  cancel: { from: ['draft', 'published', 'closed'], to: 'cancelled' },
});

/** action → { from: [...], to } — proposal lane (doc 09 §Proposal). */
const PROPOSAL_TRANSITIONS = Object.freeze({
  start_draft: { from: ['invited', 'draft'], to: 'draft' },
  submit: { from: ['invited', 'draft', 'submitted'], to: 'submitted' },
  withdraw: { from: ['submitted', 'shortlisted'], to: 'withdrawn' },
  shortlist: { from: ['submitted'], to: 'shortlisted' },
  award: { from: ['submitted', 'shortlisted'], to: 'awarded' },
  decline: { from: ['invited', 'draft', 'submitted', 'shortlisted'], to: 'declined' },
});

/**
 * @returns {{ok: true, to: string} | {ok: false, reason: string}}
 */
export function rfpTransition(status, action) {
  return apply(RFP_TRANSITIONS, 'RFP', status, action);
}

/**
 * @returns {{ok: true, to: string} | {ok: false, reason: string}}
 */
export function proposalTransition(status, action) {
  return apply(PROPOSAL_TRANSITIONS, 'proposal', status, action);
}

function apply(table, noun, status, action) {
  const rule = table[action];
  if (!rule) return { ok: false, reason: `unknown action: ${action}` };
  if (!rule.from.includes(status)) {
    return { ok: false, reason: `cannot ${action.replace(/_/g, ' ')} a ${status} ${noun}` };
  }
  return { ok: true, to: rule.to };
}
