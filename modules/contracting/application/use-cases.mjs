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
import { signatureOutcome, visibilityOf, contractBody, transition } from '../domain/lifecycle.mjs';
import {
  changeOrderTransition, measurementTransition, paymentTransition,
  changeOrderBody, changeOrderExistenceBody, measurementBody, paymentBody,
  financialsBody, cashFlowBody, lineAmountCents, retentionCents,
} from '../domain/money.mjs';

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

// ── money flow (phase 5): contract lifecycle tail ──────────────────────────

/** operationId: sponsorContract — the client covers the supplier's seat. */
export async function sponsorContract({ viewer, store, contractId }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:billing:manage' });
  if (contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client sponsors', { reason: 'relationship' });
  }
  if (['cancelled', 'terminated', 'closed'].includes(contract.status)) {
    throw new ProblemError('invalid_transition', `a ${contract.status} contract is not sponsorable`);
  }
  if (contract.sponsored_by_org_id) {
    throw new ProblemError('invalid_transition', 'this contract is already sponsored');
  }
  const actor = await requireActor(store, viewer);
  const sponsored = await store.sponsorContract({
    contractId,
    sponsorOrgId: viewer.orgId,
    sponsoredOrgId: contract.supplier_org_id,
    actor: actorOf(actor, viewer),
  });
  return { status: 200, body: bodyFor(sponsored, viewer) };
}

/** operationId: receiveProvisionally — client, no open non-conformities. */
export async function receiveProvisionally({ viewer, store, contractId }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:contracts:sign' });
  if (contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client receives the work', { reason: 'relationship' });
  }
  const open = await store.hasOpenNonConformities(contractId);
  const outcome = transition(contract.status, 'receive_provisionally', { noOpenNonConformities: !open });
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionContract({
    contractId, from: contract.status, to: outcome.to,
    eventType: 'contracting.contract.provisionally_received',
    actor: actorOf(actor, viewer), note: null,
  });
  return { status: 200, body: bodyFor(updated, viewer) };
}

/** operationId: closeContract — final reception, a manual client act. */
export async function closeContract({ viewer, store, contractId }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:contracts:sign' });
  if (contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client closes it', { reason: 'relationship' });
  }
  const outcome = transition(contract.status, 'close');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionContract({
    contractId, from: contract.status, to: outcome.to,
    eventType: 'contracting.contract.closed',
    actor: actorOf(actor, viewer), note: null,
  });
  return { status: 200, body: bodyFor(updated, viewer) };
}

/** operationId: terminateContract — either party, Decision note ledgered. */
export async function terminateContract({ viewer, store, contractId, body }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:contracts:sign' });
  requireParty(contract, viewer.orgId);
  const outcome = transition(contract.status, 'terminate');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionContract({
    contractId, from: contract.status, to: outcome.to,
    eventType: 'contracting.contract.terminated',
    actor: actorOf(actor, viewer), note: body?.note?.trim() || null,
  });
  return { status: 200, body: bodyFor(updated, viewer) };
}

/** operationId: getFinancials — value / changes / measured / retention / paid. */
export async function getFinancials({ viewer, store, contractId }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:money:view' });
  requireParty(contract, viewer.orgId);
  const totals = await store.contractFinancials(contractId);
  return { status: 200, body: financialsBody(totals) };
}

// ── change orders ───────────────────────────────────────────────────────────

const CO_KINDS = new Set(['scope', 'time', 'scope_and_time']);
const LINE_OPS = new Set(['add', 'replace', 'remove']);
const QUANTITY = /^\d+(\.\d{1,3})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** operationId: createChangeOrder — either party proposes; server numbers it. */
export async function createChangeOrder({ viewer, store, contractId, body, idempotencyKey }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:changes:propose' });
  requireParty(contract, viewer.orgId);
  if (!['signed', 'active'].includes(contract.status)) {
    throw new ProblemError('invalid_transition', 'change orders exist for signed or active contracts');
  }

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!CO_KINDS.has(body?.kind)) errors.kind = 'scope, time or scope_and_time';
  if (!body?.reason?.trim()) errors.reason = 'required';
  const lines = body?.lines ?? [];
  const time = body?.time ?? [];
  if (['scope', 'scope_and_time'].includes(body?.kind) && !lines.length) {
    errors.lines = 'a scope change carries BoQ line operations';
  }
  if (['time', 'scope_and_time'].includes(body?.kind) && !time.length) {
    errors.time = 'a time change carries new baseline dates';
  }
  lines.forEach((l, i) => {
    if (!LINE_OPS.has(l?.op)) { errors[`lines/${i}/op`] = 'add, replace or remove'; return; }
    if (l.op !== 'add' && !UUID.test(l?.boq_item_id ?? '')) errors[`lines/${i}/boq_item_id`] = 'required';
    if (l.op !== 'remove') {
      const n = l?.new_line;
      if (!UUID.test(n?.id ?? '')) errors[`lines/${i}/new_line/id`] = 'client-generated UUIDv7 required';
      if (!n?.code?.trim()) errors[`lines/${i}/new_line/code`] = 'required';
      if (!n?.description?.trim()) errors[`lines/${i}/new_line/description`] = 'required';
      if (!n?.unit?.trim()) errors[`lines/${i}/new_line/unit`] = 'required';
      if (!QUANTITY.test(n?.quantity ?? '')) errors[`lines/${i}/new_line/quantity`] = 'a decimal with up to 3 places';
      const cents = n?.unit_price?.amount_cents;
      if (!Number.isInteger(cents) || cents < 0) errors[`lines/${i}/new_line/unit_price`] = 'Money {amount_cents ≥ 0, EUR}';
    }
  });
  time.forEach((t, i) => {
    if (!UUID.test(t?.task_id ?? '')) errors[`time/${i}/task_id`] = 'required';
    for (const f of ['new_baseline_start', 'new_baseline_finish']) {
      if (t?.[f] != null && !ISO_DATE.test(t[f])) errors[`time/${i}/${f}`] = 'an ISO date';
    }
  });
  const fromVariations = body?.from_variation_ids ?? [];
  if (fromVariations.some((v) => !UUID.test(v ?? ''))) errors.from_variation_ids = 'a list of variation ids';
  if (body?.linked_change_order_id !== undefined && !UUID.test(body.linked_change_order_id ?? '')) {
    errors.linked_change_order_id = 'a change order id';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const referenced = lines.filter((l) => l.op !== 'add').map((l) => l.boq_item_id);
  if (referenced.length) {
    const known = await store.liveBoqItemsOf(contractId, referenced);
    const missing = referenced.filter((id) => !known.has(id));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, {
        errors: { lines: `not live lines of this contract: ${missing.join(', ')}` },
      });
    }
  }
  if (body?.linked_change_order_id) {
    const linked = await store.getChangeOrder(body.linked_change_order_id);
    if (!linked) {
      throw new ProblemError('validation_failed', null, { errors: { linked_change_order_id: 'unknown change order' } });
    }
  }

  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createChangeOrder', body }, async () => {
    const created = await store.createChangeOrder({
      id: body.id,
      contractId,
      projectId: contract.project_id,
      kind: body.kind,
      reason: body.reason.trim(),
      lines: lines.map((l) => ({ op: l.op, boqItemId: l.op === 'add' ? null : l.boq_item_id, newLine: l.op === 'remove' ? null : l.new_line })),
      time: time.map((t) => ({ taskId: t.task_id, newBaselineStart: t.new_baseline_start ?? null, newBaselineFinish: t.new_baseline_finish ?? null })),
      linkedChangeOrderId: body.linked_change_order_id ?? null,
      fromVariationIds: [...new Set(fromVariations)],
      idempotencyKey: idempotencyKey ?? null,
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: changeOrderBody(created) };
  });
}

/** operationId: getChangeOrder — party full; linked-chain party existence only. */
export async function getChangeOrder({ viewer, store, changeOrderId }) {
  const found = await store.getChangeOrder(changeOrderId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (isParty(found.contract, viewer.orgId)) {
    return { status: 200, body: changeOrderBody(found) };
  }
  // Back-to-back chain (ruling 11): a party of a LINKED contract learns the
  // change order exists and where it stands — amounts and lines ABSENT.
  const chain = await store.linkedChainParties(changeOrderId);
  if (chain.some((c) => isParty(c, viewer.orgId))) {
    return { status: 200, body: changeOrderExistenceBody(found.changeOrder) };
  }
  throw new ProblemError('not_found');
}

/** operationId: submitChangeOrder — proposer only; note ledgered (ruling 10). */
export async function submitChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey }) {
  return moveChangeOrder({
    viewer, store, changeOrderId, body, idempotencyKey,
    action: 'submit', operationId: 'submitChangeOrder',
    permission: 'org:changes:propose', proposerOnly: true,
    eventType: 'contracting.change_order.submitted',
  });
}

/** operationId: withdrawChangeOrder — proposer only, before a decision. */
export async function withdrawChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey }) {
  return moveChangeOrder({
    viewer, store, changeOrderId, body, idempotencyKey,
    action: 'withdraw', operationId: 'withdrawChangeOrder',
    permission: 'org:changes:propose', proposerOnly: true,
    eventType: 'contracting.change_order.withdrawn',
  });
}

/** operationId: approveChangeOrder — other party, human-only; applies the BoQ delta. */
export async function approveChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey }) {
  return decideChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey, approve: true });
}

/** operationId: rejectChangeOrder — other party, human-only. */
export async function rejectChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey }) {
  return decideChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey, approve: false });
}

async function decideChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey, approve }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'deciding a change order');
  if (!viewer.has('org:changes:decide')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getChangeOrder(changeOrderId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (!isParty(found.contract, viewer.orgId)) {
    throw new ProblemError('forbidden', 'only a contract party decides', { reason: 'relationship' });
  }
  if (found.changeOrder.proposed_by_org_id === viewer.orgId) {
    // the DB CHECK (change_order_check) backs this up — answered cleanly here
    throw new ProblemError('two_sided_rule', 'the proposing organisation never decides its own change order');
  }
  const action = approve ? 'approve' : 'reject';
  const outcome = changeOrderTransition(found.changeOrder.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: approve ? 'approveChangeOrder' : 'rejectChangeOrder', body: { changeOrderId, ...body } },
    async () => {
      const decided = await store.decideChangeOrder({
        changeOrderId,
        approve,
        note: body?.note?.trim() || null,
        actor: actorOf(actor, viewer),
      });
      return { status: 200, body: changeOrderBody(decided) };
    },
  );
}

async function moveChangeOrder({ viewer, store, changeOrderId, body, idempotencyKey, action, operationId, permission, proposerOnly, eventType }) {
  requireActiveOrg(viewer);
  if (!viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getChangeOrder(changeOrderId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (!isParty(found.contract, viewer.orgId)) {
    throw new ProblemError('forbidden', 'only a contract party acts here', { reason: 'relationship' });
  }
  if (proposerOnly && found.changeOrder.proposed_by_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', `only the proposer ${action}s a change order`, { reason: 'relationship' });
  }
  const outcome = changeOrderTransition(found.changeOrder.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId, body: { changeOrderId, ...body } },
    async () => {
      const moved = await store.transitionChangeOrder({
        changeOrderId, to: outcome.to, eventType,
        note: body?.note?.trim() || null,
        actor: actorOf(actor, viewer),
      });
      return { status: 200, body: changeOrderBody(moved) };
    },
  );
}

// ── measurements ─────────────────────────────────────────────────────────────

const PERIOD = /^\d{4}-\d{2}$/;

/** operationId: suggestMeasurement — draft-shaped, from verified rows. */
export async function suggestMeasurement({ viewer, store, contractId, query }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:measurements:submit' });
  if (contract.supplier_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract supplier measures', { reason: 'relationship' });
  }
  const period = query?.period && PERIOD.test(query.period)
    ? query.period
    : new Date().toISOString().slice(0, 7);
  const lines = await store.suggestMeasurementLines(contractId, period);
  let gross = 0;
  for (const l of lines) gross += lineAmountCents(l.quantity_this_period, l.unit_price_cents);
  const retention = retentionCents(gross, contract.retention_bp);
  return {
    status: 200,
    body: measurementBody({
      measurement: {
        id: null, contract_id: contractId, period, status: 'draft',
        gross_cents: gross, retention_cents: retention, net_cents: gross - retention,
      },
      lines,
    }),
  };
}

/** operationId: createMeasurement — supplier composes AND submits in one call. */
export async function createMeasurement({ viewer, store, contractId, body }) {
  const { contract } = await requireContract({ viewer, store, contractId, permission: 'org:measurements:submit' });
  if (contract.supplier_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract supplier measures', { reason: 'relationship' });
  }
  if (!['signed', 'active', 'provisionally_received'].includes(contract.status)) {
    throw new ProblemError('invalid_transition', 'measurements exist for live contracts');
  }
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!PERIOD.test(body?.period ?? '')) errors.period = 'YYYY-MM';
  const lines = body?.lines;
  if (!Array.isArray(lines) || !lines.length) errors.lines = 'a non-empty list';
  else {
    lines.forEach((l, i) => {
      if (!UUID.test(l?.boq_item_id ?? '')) errors[`lines/${i}/boq_item_id`] = 'required';
      if (!QUANTITY.test(l?.quantity_this_period ?? '')) errors[`lines/${i}/quantity_this_period`] = 'a decimal with up to 3 places';
    });
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const items = await store.liveBoqItemsOf(contractId, lines.map((l) => l.boq_item_id));
  const missing = lines.filter((l) => !items.has(l.boq_item_id));
  if (missing.length) {
    throw new ProblemError('validation_failed', null, {
      errors: { lines: `not live lines of this contract: ${missing.map((l) => l.boq_item_id).join(', ')}` },
    });
  }

  let gross = 0;
  for (const l of lines) gross += lineAmountCents(l.quantity_this_period, items.get(l.boq_item_id).unit_price_cents);
  const retention = retentionCents(gross, contract.retention_bp);

  const actor = await requireActor(store, viewer);
  // Replay comes from the client id + UNIQUE(contract_id, period): a duplicate
  // period answers 409 — unless the standing one is DISPUTED, which the store
  // revises back to submitted (doc 09: disputed → submitted).
  const created = await store.createMeasurement({
    id: body.id,
    contractId,
    projectId: contract.project_id,
    period: body.period,
    lines: lines.map((l) => ({ boqItemId: l.boq_item_id, quantityThisPeriod: l.quantity_this_period })),
    grossCents: gross,
    retentionCents: retention,
    netCents: gross - retention,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: measurementBody(created) };
}

/** operationId: approveMeasurement — client, human-only → expected payment. */
export async function approveMeasurement({ viewer, store, measurementId }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'approving a measurement');
  if (!viewer.has('org:measurements:approve')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getMeasurement(measurementId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (found.contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client approves', { reason: 'relationship' });
  }
  const outcome = measurementTransition(found.measurement.status, 'approve');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const approved = await store.approveMeasurement({
    measurementId,
    paymentDays: found.contract.payment_days,
    actor: actorOf(actor, viewer),
  });
  return { status: 200, body: measurementBody(approved) };
}

/** operationId: disputeMeasurement — client, with the Decision note. */
export async function disputeMeasurement({ viewer, store, measurementId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:measurements:approve')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getMeasurement(measurementId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (found.contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client disputes a measurement', { reason: 'relationship' });
  }
  const outcome = measurementTransition(found.measurement.status, 'dispute');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const disputed = await store.disputeMeasurement({
    measurementId, note: body?.note?.trim() || null, actor: actorOf(actor, viewer),
  });
  return { status: 200, body: measurementBody(disputed) };
}

// ── payments ─────────────────────────────────────────────────────────────────

/** operationId: declarePaid — client, human-only. */
export async function declarePaid({ viewer, store, paymentId }) {
  return movePayment({
    viewer, store, paymentId, action: 'declare', humanOnly: true,
    permission: 'org:payments:declare', side: 'client',
    eventType: 'contracting.payment.declared',
  });
}

/** operationId: confirmPayment — supplier, human-only. */
export async function confirmPayment({ viewer, store, paymentId }) {
  return movePayment({
    viewer, store, paymentId, action: 'confirm', humanOnly: true,
    permission: 'org:payments:confirm', side: 'supplier',
    eventType: 'contracting.payment.confirmed',
  });
}

/** operationId: disputePayment — either party, with the Decision note. */
export async function disputePayment({ viewer, store, paymentId, body }) {
  return movePayment({
    viewer, store, paymentId, action: 'dispute', humanOnly: false,
    permission: 'org:payments:confirm', side: 'party',
    eventType: 'contracting.payment.disputed', note: body?.note?.trim() || null,
  });
}

async function movePayment({ viewer, store, paymentId, action, humanOnly, permission, side, eventType, note = null }) {
  requireActiveOrg(viewer);
  if (humanOnly) requireHuman(viewer, 'moving money');
  if (!viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getPayment(paymentId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  if (side === 'client' && found.contract.client_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract client declares payment', { reason: 'relationship' });
  }
  if (side === 'supplier' && found.contract.supplier_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the contract supplier confirms receipt', { reason: 'relationship' });
  }
  if (side === 'party') requireParty(found.contract, viewer.orgId);
  const outcome = paymentTransition(found.payment.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const moved = await store.transitionPayment({
    paymentId, to: outcome.to, eventType, note, actor: actorOf(actor, viewer),
  });
  return { status: 200, body: paymentBody(moved) };
}

/** operationId: getCashFlow — OWNER org only; owner-level contracts only (V3). */
export async function getCashFlow({ viewer, store, projectId, query }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:money:view')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { project } = await requireParticipant({ viewer, store, projectId });
  if (project.owner_org_id !== viewer.orgId) {
    // Sub-level cash never rolls up to anyone (V3); the endpoint is the
    // owner's, full stop.
    throw new ProblemError('forbidden', 'cash-flow is the project owner’s view', { reason: 'relationship' });
  }
  const from = query?.from && ISO_DATE.test(query.from) ? query.from : null;
  const to = query?.to && ISO_DATE.test(query.to) ? query.to : null;
  const items = await store.ownerCashFlow(projectId, viewer.orgId, { from, to });
  return { status: 200, body: cashFlowBody({ from, to, items }) };
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

/** permission ∧ contract exists ∧ project participant — the money-op opener. */
async function requireContract({ viewer, store, contractId, permission }) {
  requireActiveOrg(viewer);
  if (permission && !viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const found = await store.getContract(contractId);
  if (!found) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: found.contract.project_id });
  return found;
}

function isParty(contract, orgId) {
  return orgId != null && (orgId === contract.client_org_id || orgId === contract.supplier_org_id);
}

function requireParty(contract, orgId) {
  if (!isParty(contract, orgId)) {
    throw new ProblemError('forbidden', 'only a contract party acts here', { reason: 'relationship' });
  }
}

/** x-human-only (doc 19): never over MCP. */
function requireHuman(viewer, what) {
  if (viewer.channel === 'mcp') {
    throw new ProblemError('forbidden', `${what} is human-only`, { reason: 'human_only' });
  }
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
