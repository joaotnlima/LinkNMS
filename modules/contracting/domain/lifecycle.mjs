// Contract lifecycle + viewer projection — pure (no I/O), to-be docs 06, 09.
//
// The state machine is the doc-06 diagram verbatim. Phase 3 only OPERATES
// sign (create/get/list/update/sign); the rest of the table is here because
// the lifecycle is one fact, and phase 5 wires the remaining operations over
// the same transitions.

/** action → { from: [...], to, guard? } — doc 09 §Contract. */
const TRANSITIONS = Object.freeze({
  sign: { from: ['draft'], to: 'signed', guard: 'bothPartiesSigned' },
  activate: { from: ['signed'], to: 'active' },
  receive_provisionally: { from: ['active'], to: 'provisionally_received', guard: 'noOpenNonConformities' },
  close: { from: ['provisionally_received'], to: 'closed' },
  cancel: { from: ['draft'], to: 'cancelled' },
  terminate: { from: ['signed', 'active'], to: 'terminated' },
});

/**
 * @returns {{ok: true, to: string} | {ok: false, reason: string}}
 */
export function transition(status, action, guards = {}) {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `unknown action: ${action}` };
  if (!rule.from.includes(status)) {
    return { ok: false, reason: `cannot ${action} a ${status} contract` };
  }
  if (rule.guard && !guards[rule.guard]) {
    return { ok: false, reason: guardReason(rule.guard) };
  }
  return { ok: true, to: rule.to };
}

function guardReason(guard) {
  return {
    bothPartiesSigned: 'both parties must sign first',
    noOpenNonConformities: 'open non-conformities block provisional reception',
  }[guard];
}

/**
 * What one more signature by `signerOrgId` means for a draft contract.
 * Signing is per ORG (contract_signature is UNIQUE(contract_id, org_id)).
 */
export function signatureOutcome({ signatures, signerOrgId, clientOrgId, supplierOrgId }) {
  const signed = new Set(signatures.map((s) => s.org_id));
  if (signed.has(signerOrgId)) return { alreadySigned: true, becomesSigned: false };
  signed.add(signerOrgId);
  return {
    alreadySigned: false,
    becomesSigned: signed.has(clientOrgId) && signed.has(supplierOrgId),
  };
}

/**
 * Which projection of a contract a viewer org gets (doc 04 V2/V3):
 *   'full'  — the parties (client or supplier org);
 *   'scope' — everyone else who may know it exists (ancestor clients per V3,
 *             and project participants seeing the tree): commercial terms
 *             and value ABSENT, scope/status/dates present.
 */
export function visibilityOf(contract, viewerOrgId) {
  if (viewerOrgId === contract.client_org_id || viewerOrgId === contract.supplier_org_id) {
    return 'full';
  }
  return 'scope';
}

/**
 * The wire body of api/v2 #/components/schemas/Contract, projected.
 * Money is a FIELD-ABSENT projection, never null (invariant §6.5): absent
 * unless the view is full AND the person holds org:money:view.
 */
export function contractBody({ contract, client, supplier, roots, signatures, valueCents }, { visibility, canSeeMoney }) {
  const full = visibility === 'full';
  return {
    id: contract.id,
    project_id: contract.project_id,
    kind: contract.kind,
    parent_contract_id: contract.parent_contract_id ?? undefined,
    reference: contract.reference,
    client: orgBody(client),
    supplier: orgBody(supplier),
    specialties: contract.specialties ?? [],
    scope_inclusions: contract.scope_inclusions ?? undefined,
    scope_exclusions: contract.scope_exclusions ?? undefined,
    ...(full ? {
      payment_terms: contract.payment_terms,
      retention_bp: contract.retention_bp,
      payment_days: contract.payment_days,
    } : {}),
    contractual_start: dateOnly(contract.contractual_start),
    contractual_end: dateOnly(contract.contractual_end),
    revision: contract.revision,
    status: contract.status,
    ...(full && canSeeMoney
      ? { value: { amount_cents: Number(valueCents ?? 0), currency: 'EUR' } }
      : {}),
    root_task_ids: roots,
    signatures: signatures.map((s) => ({
      org_id: s.org_id, person_id: s.person_id, signed_at: iso(s.signed_at),
    })),
    sponsored_by_org_id: contract.sponsored_by_org_id ?? undefined,
    _visibility: visibility,
    version: contract.version,
  };
}

function orgBody(org) {
  if (!org) return undefined;
  return { id: org.id, kind: org.kind, legal_name: org.legal_name, nif: org.nif ?? undefined };
}

function iso(value) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** date columns come back as Date at UTC midnight; the wire wants YYYY-MM-DD. */
function dateOnly(value) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
