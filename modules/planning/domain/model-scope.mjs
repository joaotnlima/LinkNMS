// The plan facts the shared project model needs (PRD-07 M-3, M-6, M-8, M-9),
// pure. Documents owns the model and its record-side edits; planning owns the
// rows and the D-33 edit scope, so it answers — through the task port — which
// rows each organisation may edit, plus each row's outline code, name, status
// and effective assignee for the model's legend.
//
// M-8: an organisation's model edit scope is the elements linked to rows in its
// D-33 edit scope — the GC's whole branch (it is the client up the chain of its
// subs' rows), an awarded company only its awarded rows. M-9: that scope opens
// on award (the award's contract binds the branch) and CLOSES when the contract
// is cancelled, terminated or closed — those contracts are dropped from the
// world before the D-33 walk, so a branch under an ended contract is nobody's
// but the owner's.
import { inEditScope, effectiveAssignee } from './scope.mjs';

/** Contract states after which the supplier no longer edits its branch (M-9). */
export const ENDED_CONTRACT_STATES = Object.freeze(['cancelled', 'terminated', 'closed']);

/** The D-33 world with ended contracts removed. */
export function liveWorld(plan) {
  const contracts = new Map();
  for (const [id, c] of plan.contracts ?? new Map()) {
    if (!ENDED_CONTRACT_STATES.includes(c.status)) contracts.set(id, c);
  }
  return { ownerOrgId: plan.ownerOrgId ?? null, contracts };
}

/**
 * Outline codes ("2", "2.5", "2.5.1") from the tree order: siblings by
 * position (fractional keys compare as strings), roots first.
 * @param {Map<string, {id, parentId, position}>} tasks
 * @returns {Map<string, string>}
 */
export function outlineCodes(tasks) {
  const children = new Map();
  for (const t of tasks.values()) {
    const key = t.parentId && tasks.has(t.parentId) ? t.parentId : null;
    const list = children.get(key);
    if (list) list.push(t);
    else children.set(key, [t]);
  }
  const codes = new Map();
  const walk = (parentId, prefix) => {
    const kids = (children.get(parentId) ?? []).slice()
      .sort((a, b) => (String(a.position) < String(b.position) ? -1 : String(a.position) > String(b.position) ? 1 : 0));
    kids.forEach((t, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      codes.set(t.id, code);
      walk(t.id, code);
    });
  };
  walk(null, '');
  return codes;
}

/**
 * The model-scope answer of the task port for one project.
 * @param {{tasks: Map, contracts: Map, ownerOrgId: string|null, statuses?: Map, orgNames?: Map}} plan
 * @returns {{ owner_org_id, tasks: object[], editors: {org_id, org_name, task_ids: string[]}[] }}
 *   `editors` — every organisation (other than the owner, who edits the whole
 *   model) with at least one row in its live D-33 edit scope.
 */
export function modelScopesOf(plan) {
  const world = liveWorld(plan);
  const codes = outlineCodes(plan.tasks);
  const tasks = [...plan.tasks.values()]
    .map((t) => {
      const a = effectiveAssignee(plan.tasks, t.id);
      return {
        id: t.id,
        code: codes.get(t.id) ?? '',
        name: t.name,
        parent_id: t.parentId ?? null,
        status: plan.statuses?.get(t.id) ?? 'not_started',
        assignee_org_id: a?.orgId ?? null,
        assignee_org_name: a ? plan.orgNames?.get(a.orgId) ?? null : null,
      };
    })
    .sort((a, b) => compareCodes(a.code, b.code));

  const orgs = new Set();
  for (const c of world.contracts.values()) {
    if (c.supplierOrgId) orgs.add(c.supplierOrgId);
    if (c.clientOrgId) orgs.add(c.clientOrgId);
  }
  orgs.delete(world.ownerOrgId);
  const editors = [];
  for (const orgId of orgs) {
    const taskIds = [];
    for (const t of plan.tasks.values()) {
      if (inEditScope(world, t, orgId)) taskIds.push(t.id);
    }
    if (taskIds.length) {
      editors.push({ org_id: orgId, org_name: plan.orgNames?.get(orgId) ?? null, task_ids: taskIds });
    }
  }
  editors.sort((a, b) => b.task_ids.length - a.task_ids.length || String(a.org_id).localeCompare(String(b.org_id)));
  return { owner_org_id: world.ownerOrgId, tasks, editors };
}

/** "2.10" after "2.9": numeric segment order. */
export function compareCodes(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}
