// Planning ↔ directory taxonomy (PRD-03 R-2). A row may carry an optional
// `specialty_code`; the code is checked through the directory's published
// specialty port (injected at the composition root) — planning never reads
// directory.specialty. `specialty` stays the free-text label of the row.
//
// Also the "On the record" facts a `done` report carries for the directory's
// read model (to-be/10): who did the row, under which contract, planned vs
// actual finish. No amounts.
import { ProblemError } from '../../../platform/errors.mjs';
import { effectiveAssignee } from '../domain/scope.mjs';

export const SPECIALTY_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 422 unless every non-null code is a taxonomy code.
 * @param {{ exists: (code: string) => Promise<boolean> }|undefined} port
 * @param {Array<[string, unknown]>} entries  [field key for the error, code]
 */
export async function assertSpecialtyCodes(port, entries) {
  const errors = {};
  for (const [key, code] of entries) {
    if (code == null) continue;
    if (typeof code !== 'string' || !SPECIALTY_CODE.test(code) || code.length > 60) {
      errors[key] = 'a specialty code from GET /specialties';
    } else if (!port) {
      errors[key] = 'the specialty taxonomy is not available — retry later';
    } else if (!(await port.exists(code))) {
      errors[key] = `unknown specialty code: ${code}`;
    }
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
}

/**
 * The on-record facts of a row reported done (planning.progress.reported
 * data). Who did it: the effective assignee, else the supplier of the row's
 * branch contract (D-33: a branch is its supplier's work).
 * @param {Map} tasks
 * @param {string} taskId
 * @param {Map<string, {supplierOrgId: string}>} contracts  world(plan).contracts
 */
export function onRecordFacts(tasks, taskId, contracts = new Map()) {
  const t = tasks.get(taskId);
  if (!t) return null;
  const contractId = t.contractId ?? t.branchContractId ?? null;
  return {
    assignee_org_id: effectiveAssignee(tasks, taskId)?.orgId ?? contracts.get(contractId)?.supplierOrgId ?? null,
    contract_id: contractId,
    baseline_finish: t.baselineFinish ?? null,
    actual_finish: t.actualFinish ?? null,
  };
}
