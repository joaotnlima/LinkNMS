// Quality lifecycles + wire projection — pure (no I/O), to-be docs 08, 09.
//
// Two state machines, both doc-09 verbatim:
//   verification_request:  pending → accepted | rejected  (terminal either way)
//   nonconformity:         open → assigned → fixed → closed
//                          fixed → rejected_fix → (assigned | fixed)
// Closure of a non-conformity belongs to the RAISING org (DB CHECK backs it),
// and nobody decides a verification their own org asked for (D-31, check 8g).

/** action → { from: [...], to } — verification_request. */
const VERIFICATION_TRANSITIONS = Object.freeze({
  accept: { from: ['pending'], to: 'accepted' },
  reject: { from: ['pending'], to: 'rejected' },
});

/** action → { from: [...], to } — nonconformity (doc 09 §Non-conformity). */
const NONCONFORMITY_TRANSITIONS = Object.freeze({
  assign: { from: ['open', 'rejected_fix'], to: 'assigned' },
  fix: { from: ['assigned', 'rejected_fix'], to: 'fixed' },
  close: { from: ['fixed'], to: 'closed' },
  reject_fix: { from: ['fixed'], to: 'rejected_fix' },
});

/**
 * @returns {{ok: true, to: string} | {ok: false, reason: string}}
 */
export function verificationTransition(status, action) {
  return apply(VERIFICATION_TRANSITIONS, 'verification', status, action);
}

/**
 * @returns {{ok: true, to: string} | {ok: false, reason: string}}
 */
export function nonConformityTransition(status, action) {
  return apply(NONCONFORMITY_TRANSITIONS, 'non-conformity', status, action);
}

function apply(table, noun, status, action) {
  const rule = table[action];
  if (!rule) return { ok: false, reason: `unknown action: ${action}` };
  if (!rule.from.includes(status)) {
    return { ok: false, reason: `cannot ${action.replace('_', ' ')} a ${status} ${noun}` };
  }
  return { ok: true, to: rule.to };
}

// ── wire bodies (api/v2 components/schemas) ────────────────────────────────
// Withheld or unknown fields are ABSENT, never null (invariant §6.5).

/** #/components/schemas/Verification. */
export function verificationBody(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    task_name: row.task_name ?? undefined,
    // Requests are minted by the progress consumer, which only knows the
    // reporting ORG — person/role unknowable, so absent (Actor is all-optional).
    requested_by: { org_id: row.requested_by_org_id },
    criteria: row.criteria_snapshot ?? undefined,
    status: row.status,
    ...(row.decided_by_org_id ? {
      decided_by: {
        org_id: row.decided_by_org_id,
        ...(row.decided_by_person_id ? { person_id: row.decided_by_person_id } : {}),
      },
    } : {}),
    reason: row.reason ?? undefined,
    decided_at: iso(row.decided_at),
  };
}

/** #/components/schemas/NonConformity. */
export function nonConformityBody(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    task_id: row.task_id ?? undefined,
    kind: row.kind,
    severity: row.severity,
    description: row.description,
    photo_document_ids: row.photo_document_ids ?? [],
    raised_by: { person_id: row.raised_by_person_id, org_id: row.raised_by_org_id },
    assigned_to_org_id: row.assigned_to_org_id ?? undefined,
    status: row.status,
  };
}

/** #/components/schemas/Inspection. */
export function inspectionBody(row) {
  return {
    id: row.id,
    kind: row.kind,
    date: dateOnly(row.date),
    checklist: row.checklist ?? [],
    findings: row.findings ?? undefined,
    task_ids: row.task_ids ?? [],
  };
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
