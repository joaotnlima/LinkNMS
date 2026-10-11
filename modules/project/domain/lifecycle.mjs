// Project lifecycle — the doc-09 transition table as data, executed by one
// transition() function. Statuses are the DB enum of project.project.status;
// guards are evaluated by the caller (they need queries) and passed in as
// booleans, so this stays pure and every row is testable.

export const STATUSES = Object.freeze([
  'draft', 'tendering', 'contracted', 'in_execution', 'closed', 'cancelled',
]);

/** action → { from: [...], to, guard } — doc 09 §Project, verbatim. */
export const TRANSITIONS = Object.freeze({
  publish_first_rfp: { from: ['draft'], to: 'tendering', guard: 'briefComplete' },
  sign_first_owner_contract: { from: ['draft', 'tendering'], to: 'contracted', guard: 'ownerContractSigned' },
  start: { from: ['contracted'], to: 'in_execution', guard: 'firstTaskInProgress' },
  close: { from: ['in_execution'], to: 'closed', guard: 'allOwnerContractsSettled' },
  cancel: { from: ['draft', 'tendering'], to: 'cancelled', guard: 'noSignedContract' },
});

/**
 * @param {string} status  current project.status
 * @param {string} action  a TRANSITIONS key
 * @param {Record<string, boolean>} guards  evaluated guard facts by name
 * @returns {{ ok: true, to: string } | { ok: false, reason: string }}
 */
export function transition(status, action, guards = {}) {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `unknown action ${action}` };
  if (!rule.from.includes(status)) {
    return { ok: false, reason: `cannot ${action} a ${status} project` };
  }
  if (!guards[rule.guard]) {
    return { ok: false, reason: `guard failed: ${rule.guard}` };
  }
  return { ok: true, to: rule.to };
}

/** Doc 09 guard "brief complete" — what :publish_first_rfp will check. */
export function briefComplete(project) {
  return Boolean(project.name?.trim() && project.municipality_code && project.owner_org_id);
}

/**
 * D-35: operating_model is DERIVED for display from the owner-level
 * contracts in status >= signed. Never stored.
 * @param {{ prime: number, direct: number }} counts
 */
export function operatingModel({ prime, direct }) {
  if (prime > 0 && direct > 0) return 'hybrid';
  if (prime > 0) return 'turnkey';
  if (direct > 0) return 'direct';
  return 'undetermined';
}

// ── Project phases (doc 09 §Project phase; ADR-0024, PRD-10 E-13) ──────────
// The phase that carries the plan's execution sign-off. `start_execution` is
// the v2 activation: the build's FIRST baseline (D-43: taken at award, or at
// signature where no award took one) means a branch is now controlled — there
// is a committed plan to execute and, later, to sign off. Procurement is NOT
// closed by it: specialty-by-specialty tendering goes on (D-43).
export const PHASE_STATUSES = Object.freeze(['pending', 'active', 'signed_off', 'archived']);

export const PHASE_TRANSITIONS = Object.freeze({
  start_execution: { kind: 'execution', from: ['pending'], to: 'active', guard: 'baselineTaken' },
  sign_off: { kind: 'execution', from: ['active'], to: 'signed_off', guard: 'signOffApproved' },
});

/**
 * @param {{kind: string, status: string}} phase
 * @param {string} action a PHASE_TRANSITIONS key
 * @param {Record<string, boolean>} guards
 */
export function phaseTransition(phase, action, guards = {}) {
  const rule = PHASE_TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `unknown action ${action}` };
  if (phase?.kind !== rule.kind) return { ok: false, reason: `${action} applies to the ${rule.kind} phase` };
  if (!rule.from.includes(phase.status)) return { ok: false, reason: `cannot ${action} a ${phase.status} phase` };
  if (!guards[rule.guard]) return { ok: false, reason: `guard failed: ${rule.guard}` };
  return { ok: true, to: rule.to };
}
