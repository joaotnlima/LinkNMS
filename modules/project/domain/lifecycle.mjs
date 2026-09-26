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
