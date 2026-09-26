// Tendering wire projections — pure (no I/O), api/v2 components/schemas.
// Withheld or unknown fields are ABSENT, never null (invariant §6.5).
//
// Two confidentiality layers meet here (docs 04, 16 §5):
//   V8 — a lane belongs to the issuer and its bidder; the STORE never hands
//        this layer a foreign lane, but the projection still never leaks the
//        asker of a clarification to a bidder;
//   money — `total`/`unit_price`/`median` are absent without `org:money:view`,
//        even for people of a party org.

/** #/components/schemas/Rfp. */
export function rfpBody(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    issuer_org_id: row.issuer_org_id,
    level: row.level,
    ...(row.parent_contract_id ? { parent_contract_id: row.parent_contract_id } : {}),
    root_task_ids: row.root_task_ids ?? [],
    title: row.title,
    scope_text: row.scope_text ?? undefined,
    specialties: row.specialties ?? [],
    visibility: row.visibility,
    questions_deadline: iso(row.questions_deadline),
    submission_deadline: iso(row.submission_deadline),
    package_version: row.package_version,
    status: row.status,
    ...(row.awarded_proposal_id ? { awarded_proposal_id: row.awarded_proposal_id } : {}),
    version: row.version,
  };
}

/**
 * The package a bidder prices: subtree structure + quantities, never prices
 * (doc 05 §10). Response-only extension of Rfp on getRfp (see CHANGELOG).
 */
export function packageBody(rows, items) {
  return {
    rows: rows.map((r) => ({
      task_id: r.task_id,
      ...(r.parent_task_id ? { parent_task_id: r.parent_task_id } : {}),
      name: r.name,
      scope_text: r.scope_text ?? undefined,
      specialty: r.specialty ?? undefined,
      position: r.position,
    })),
    items: items.map((i) => ({
      rfp_item_id: i.id,
      task_id: i.task_id,
      code: i.code,
      description: i.description,
      unit: i.unit,
      quantity: String(i.quantity),
      material_spec: i.material_spec ?? undefined,
      specialty: i.specialty ?? undefined,
    })),
  };
}

/** #/components/schemas/Recipient — issuer only. */
export function recipientBody(row, { token } = {}) {
  return {
    id: row.id,
    ...(row.org_id ? { org_id: row.org_id } : {}),
    email: row.email,
    status: row.status,
    sent_at: iso(row.sent_at),
    opened_at: iso(row.opened_at),
    // Response-only, once, to the issuer in the 201 — the notifications
    // module (email delivery) is a later phase; without the raw token the
    // personal link would be unreachable (same rationale as
    // ProjectInvitation.token, phase 2).
    ...(token ? { token } : {}),
  };
}

/** #/components/schemas/Clarification — the asker is NEVER on the wire. */
export function clarificationBody(row) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer ?? undefined,
    status: row.status,
    answered_at: iso(row.answered_at),
  };
}

/**
 * #/components/schemas/ProposalLane — the dashed pseudo-row (D-36).
 * `summary` fields come from the latest submitted revision (platform) or the
 * issuer-typed summary (email). Money absent without `org:money:view`.
 */
export function laneBody(row, { seesMoney }) {
  return {
    proposal_id: row.id,
    bidder: {
      ...(row.bidder_org_id ? { org_id: row.bidder_org_id } : {}),
      ...(row.bidder_name ? { name: row.bidder_name } : {}),
      email: row.email,
    },
    channel: row.channel,
    status: row.status,
    ...(seesMoney && row.summary_total_cents != null
      ? { total: money(row.summary_total_cents) } : {}),
    duration_wd: row.summary_duration_wd ?? undefined,
    start: dateOnly(row.summary_start),
    missing_lines: Number(row.missing_lines ?? 0),
    variant_lines: Number(row.variant_lines ?? 0),
    document_count: (row.document_ids ?? []).length,
    has_plan: Boolean(row.has_plan),
    url: `/proposals/${row.id}`,
  };
}

/** #/components/schemas/Proposal — full document (issuer | author only). */
export function proposalBody(row, { rows = [], links = [], lines = [], seesMoney }) {
  return {
    id: row.id,
    rfp_id: row.rfp_id,
    channel: row.channel,
    status: row.status,
    revision: row.current_revision,
    rows: rows.map((r) => ({
      id: r.id,
      packaged_task_id: r.packaged_task_id ?? null,
      parent_row_id: r.parent_row_id ?? null,
      kind: r.kind,
      name: r.name,
      duration_wd: r.duration_wd ?? undefined,
      start: dateOnly(r.start),
      finish: dateOnly(r.finish),
    })),
    links: links.map((l) => ({
      predecessor_id: l.predecessor_row,
      successor_id: l.successor_row,
      from_anchor: l.from_anchor,
      to_anchor: l.to_anchor,
      lag_wd: l.lag_wd,
    })),
    lines: lines.map((l) => ({
      ...(l.rfp_item_id ? { rfp_item_id: l.rfp_item_id } : {}),
      ...(l.proposal_row_id ? { proposal_row_id: l.proposal_row_id } : {}),
      is_variant: l.is_variant,
      description: l.description,
      unit: l.unit,
      quantity: String(l.quantity),
      ...(seesMoney ? { unit_price: money(l.unit_price_cents) } : {}),
    })),
    ...(seesMoney && row.summary_total_cents != null ? {
      summary: {
        total: money(row.summary_total_cents),
        ...(row.summary_duration_wd != null ? { duration_wd: row.summary_duration_wd } : {}),
        ...(row.summary_start ? { start: dateOnly(row.summary_start) } : {}),
      },
    } : {}),
    conditions: row.conditions ?? undefined,
    validity_until: dateOnly(row.validity_until),
    document_ids: row.document_ids ?? [],
    version: row.version,
  };
}

export function money(cents) {
  return { amount_cents: Number(cents), currency: 'EUR' };
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
