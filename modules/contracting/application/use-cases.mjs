// Contracting module use cases (phase 3) — one function per operationId:
// createContract, listContracts, getContract, updateContract, signContract.
//
// Authorization is the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship ∧ staffing.
// Relationships (openapi x-relationship):
//   project.participant — read side (list/get), the project-module rule;
//   client — createContract: for prime/direct/service the CLIENT is the
//     project owner; for sub, the supplier of the parent contract;
//   contract.client (draft) — updateContract;
//   contract party — signContract, by a manager/admin of the org (doc 06:
//     "in-app acceptance by a manager of each org"), never over MCP
//     (x-human-only).
// Projection (doc 04): V2 parties full; V3 everyone else scope-only; money
// additionally gated by org:money:view (invariant §6.5) — domain/lifecycle.
//
// The store owns transactions AND writes ledger + outbox inside them
// (invariants §6.3/§6.4); a use case never half-commits.
import { ProblemError } from '../../../platform/errors.mjs';
import { signatureOutcome, visibilityOf, contractBody } from '../domain/lifecycle.mjs';

const KINDS = new Set(['prime', 'direct', 'sub', 'service']);
const PAYMENT_TERMS = new Set(['measurement_monthly', 'milestones', 'mixed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** operationId: createContract — direct entry of an off-platform deal. */
export async function createContract({ viewer, store, projectId, body, idempotencyKey }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:contracts:sign')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { project } = await requireParticipant({ viewer, store, projectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!KINDS.has(body?.kind)) errors.kind = 'prime, direct, sub or service';
  if (body?.kind === 'sub') {
    if (!UUID.test(body?.parent_contract_id ?? '')) errors.parent_contract_id = 'required for a sub contract';
  } else if (body?.parent_contract_id) {
    errors.parent_contract_id = 'only a sub contract has a parent';
  }
  if (body?.supplier_email && !body?.supplier_org_id) {
    // The email lane (invite an off-platform supplier) needs directory +
    // tendering (phases 6/9); the model requires a supplier org to hold the
    // contract. Documented limitation, not silently accepted.
    errors.supplier_email = 'not yet supported — pass supplier_org_id of a registered organisation';
  }
  if (!UUID.test(body?.supplier_org_id ?? '')) errors.supplier_org_id = 'required';
  const roots = body?.root_task_ids;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
    errors.root_task_ids = 'a non-empty list of task ids';
  }
  if (body?.payment_terms !== undefined && !PAYMENT_TERMS.has(body.payment_terms)) {
    errors.payment_terms = 'measurement_monthly, milestones or mixed';
  }
  if (body?.retention_bp !== undefined
      && (!Number.isInteger(body.retention_bp) || body.retention_bp < 0 || body.retention_bp > 10000)) {
    errors.retention_bp = 'basis points 0..10000';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // Relationship: who the CLIENT is follows from the kind (doc 06).
  let clientOrgId;
  if (body.kind === 'sub') {
    const parent = await store.getContract(body.parent_contract_id);
    if (!parent || parent.contract.project_id !== projectId) {
      throw new ProblemError('validation_failed', null, { errors: { parent_contract_id: 'not a contract of this project' } });
    }
    if (!['signed', 'active'].includes(parent.contract.status)) {
      throw new ProblemError('invalid_transition', 'the parent contract is not live');
    }
    if (parent.contract.supplier_org_id !== viewer.orgId) {
      throw new ProblemError('forbidden', 'only the supplier of the parent contract subcontracts inside it', { reason: 'relationship' });
    }
    clientOrgId = viewer.orgId;
  } else {
    if (project.owner_org_id !== viewer.orgId) {
      throw new ProblemError('forbidden', 'only the project owner contracts at this level', { reason: 'relationship' });
    }
    clientOrgId = viewer.orgId;
  }

  if (body.supplier_org_id === clientOrgId) {
    // C1 (client ≠ supplier) answered as a clean 422, not a DB error.
    throw new ProblemError('validation_failed', null, { errors: { supplier_org_id: 'client and supplier must differ' } });
  }
  const supplier = await store.getOrganization(body.supplier_org_id);
  if (!supplier) {
    throw new ProblemError('validation_failed', null, { errors: { supplier_org_id: 'unknown organisation' } });
  }
  const known = await store.tasksOfProject(projectId, roots);
  const missing = roots.filter((t) => !known.has(t));
  if (missing.length) {
    throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
  }

  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createContract', body }, async () => {
    const created = await store.createContract({
      id: body.id,
      projectId,
      kind: body.kind,
      parentContractId: body.kind === 'sub' ? body.parent_contract_id : null,
      clientOrgId,
      supplierOrgId: body.supplier_org_id,
      reference: body.reference?.trim() || `CTR-${body.id.slice(0, 8).toUpperCase()}`,
      paymentTerms: body.payment_terms ?? 'measurement_monthly',
      retentionBp: body.retention_bp ?? 500,
      scopeInclusions: body.scope_inclusions ?? null,
      scopeExclusions: body.scope_exclusions ?? null,
      rootTaskIds: [...new Set(roots)],
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: bodyFor(created, viewer) };
  });
}

/** operationId: listContracts — the tree, projected per viewer (V2/V3). */
export async function listContracts({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listContracts(projectId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return {
    status: 200,
    body: { items: items.map((c) => bodyFor(c, viewer)), next_cursor: nextCursor },
  };
}

/** operationId: getContract */
export async function getContract({ viewer, store, contractId }) {
  const found = await store.getContract(contractId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  return { status: 200, body: bodyFor(found, viewer) };
}

/** operationId: updateContract — the client edits a DRAFT's terms. */
export async function updateContract({ viewer, store, contractId, body, ifMatch }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:contracts:sign')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getContract(contractId);
  if (!found) throw new ProblemError('not_found');
  const { contract } = found;
  await requireParticipant({ viewer, store, projectId: contract.project_id });
  if (contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client edits the draft', { reason: 'relationship' });
  }
  if (contract.status !== 'draft') {
    throw new ProblemError('invalid_transition', 'a contract changes after signature only via change orders');
  }
  const expected = parseIfMatch(ifMatch);
  if (expected !== contract.version) {
    throw new ProblemError('version_conflict', `contract is at version ${contract.version}`);
  }

  const errors = {};
  if (body?.payment_terms !== undefined && !PAYMENT_TERMS.has(body.payment_terms)) {
    errors.payment_terms = 'measurement_monthly, milestones or mixed';
  }
  if (body?.retention_bp !== undefined
      && (!Number.isInteger(body.retention_bp) || body.retention_bp < 0 || body.retention_bp > 10000)) {
    errors.retention_bp = 'basis points 0..10000';
  }
  if (body?.reference !== undefined && !body.reference?.trim()) errors.reference = 'must not be blank';
  let roots;
  if (body?.root_task_ids !== undefined) {
    roots = body.root_task_ids;
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
      errors.root_task_ids = 'a non-empty list of task ids';
    }
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (roots) {
    const known = await store.tasksOfProject(contract.project_id, roots);
    const missing = roots.filter((t) => !known.has(t));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
    }
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.updateDraft({
    contractId,
    expectedVersion: expected,
    patch: {
      reference: body?.reference?.trim(),
      paymentTerms: body?.payment_terms,
      retentionBp: body?.retention_bp,
      scopeInclusions: body?.scope_inclusions,
      scopeExclusions: body?.scope_exclusions,
      rootTaskIds: roots ? [...new Set(roots)] : undefined,
    },
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'someone changed the draft first');
  return { status: 200, body: bodyFor(updated, viewer) };
}

/** operationId: signContract — human-only; both parties → signed. */
export async function signContract({ viewer, store, contractId }) {
  requireActiveOrg(viewer);
  if (viewer.channel === 'mcp') {
    // x-human-only: signing is a human act, never an agent's (doc 19).
    throw new ProblemError('forbidden', 'signing a contract is human-only', { reason: 'human_only' });
  }
  if (!viewer.has('org:contracts:sign')) throw new ProblemError('forbidden', null, { reason: 'role' });
  if (!['admin', 'manager'].includes(viewer.orgRole)) {
    throw new ProblemError('forbidden', 'a manager of the organisation signs (doc 06)', { reason: 'role' });
  }
  const found = await store.getContract(contractId);
  if (!found) throw new ProblemError('not_found');
  const { contract, signatures } = found;
  await requireParticipant({ viewer, store, projectId: contract.project_id });
  if (![contract.client_org_id, contract.supplier_org_id].includes(viewer.orgId)) {
    throw new ProblemError('forbidden', 'only a contract party signs', { reason: 'relationship' });
  }
  if (contract.status !== 'draft') {
    throw new ProblemError('invalid_transition', `cannot sign a ${contract.status} contract`);
  }
  const outcome = signatureOutcome({
    signatures,
    signerOrgId: viewer.orgId,
    clientOrgId: contract.client_org_id,
    supplierOrgId: contract.supplier_org_id,
  });
  if (outcome.alreadySigned) {
    throw new ProblemError('invalid_transition', 'your organisation has already signed');
  }

  const actor = await requireActor(store, viewer);
  const signed = await store.addSignature({
    contractId,
    orgId: viewer.orgId,
    personId: actor.id,
    becomesSigned: outcome.becomesSigned,
    actor: actorOf(actor, viewer),
  });
  return { status: 200, body: bodyFor(signed, viewer) };
}

// ── shared helpers ───────────────────────────────────────────────────────

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/** relationship: project.participant (∧ staffing for non-managers) — doc 16 §4. */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  // 404, not 403: a non-participant does not learn the project exists.
  if (!related) throw new ProblemError('not_found');
  if (!seesWholeOrg(viewer)) {
    const actor = await requireActor(store, viewer);
    if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
  return { project };
}

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function parseIfMatch(raw) {
  const n = Number(String(raw ?? '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw new ProblemError('validation_failed', 'If-Match must carry the contract version');
  return n;
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** Project one store row-bundle for this viewer (doc 04 V2/V3 + §6.5). */
function bodyFor(found, viewer) {
  const visibility = visibilityOf(found.contract, viewer.orgId);
  return contractBody(found, { visibility, canSeeMoney: viewer.has('org:money:view') });
}
