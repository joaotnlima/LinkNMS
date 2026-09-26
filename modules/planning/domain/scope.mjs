// D-33 edit scope + assignee inheritance, pure.
//
// A branch is a row bound to a contract (task.branch_contract_id materialises
// the nearest bound ancestor) plus everything under it. An organisation may
// edit: its own branches (contract supplier), every branch of contracts it is
// the CLIENT of anywhere up the chain, and — if it is the owner — everything,
// including rows outside any branch. Everyone else: read-only.
//
// While a supplier-created project is unclaimed, its creator drives the plan
// the way it drives the brief (doc 14 Q4) — the caller passes that org as
// `ownerOrgId`.

/**
 * @param {{ownerOrgId: string|null, contracts: Map<string, {supplierOrgId, clientOrgId, parentContractId}>}} world
 * @param {{branchContractId: string|null}} task
 * @param {string} orgId
 */
export function inEditScope(world, task, orgId) {
  if (!orgId) return false;
  if (world.ownerOrgId && orgId === world.ownerOrgId) return true;
  let contractId = task.branchContractId ?? null;
  if (!contractId) return false; // outside every branch: the owner's ground
  const seen = new Set();
  let contract = world.contracts.get(contractId);
  if (contract?.supplierOrgId === orgId) return true;
  while (contract && !seen.has(contractId)) {
    seen.add(contractId);
    if (contract.clientOrgId === orgId) return true;
    contractId = contract.parentContractId;
    contract = contractId ? world.contracts.get(contractId) : null;
  }
  return false;
}

/**
 * Effective assignee of a row: its own, or the nearest assigned ancestor's
 * (D-33 "assignee inherited from the branch").
 * @returns {{orgId, personId, inherited: boolean} | null}
 */
export function effectiveAssignee(tasks, taskId) {
  let t = tasks.get(taskId);
  if (!t) return null;
  if (t.assigneeOrgId) {
    return { orgId: t.assigneeOrgId, personId: t.assigneePersonId ?? null, inherited: false };
  }
  let cur = t.parentId ? tasks.get(t.parentId) : null;
  while (cur) {
    if (cur.assigneeOrgId) {
      return { orgId: cur.assigneeOrgId, personId: cur.assigneePersonId ?? null, inherited: true };
    }
    cur = cur.parentId ? tasks.get(cur.parentId) : null;
  }
  return null;
}
