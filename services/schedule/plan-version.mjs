// Slice B2 — plan proposal → review → baseline v1 lifecycle (LINA-200-BE; frozen
// contract docs/architecture/slice-b2-plan-baseline-contract.md §4–§6; anchors
// ADR-0012 §B, ADR-0002 §4/§5, ADR-0004, ADR-0006 §1).
//
// This is the service orchestration for the D11–D13 plan-baseline flow:
//   - GET  /plan            → { baseline, current, history } (the D11–D13 view)
//   - POST …:withdraw       → proposer retracts an open proposal (terminal)
//   - POST …:accept         → reviewer stamps 'accepted'; the SECOND stamp (the
//                             proposer's authorship + the reviewer's acceptance)
//                             freezes the version → project_baseline upsert
//   - POST …:reject         → reviewer rejects (terminal)
//   - POST …:request-changes→ reviewer forks a NEW version authoring dates-and-
//                             money-only edits; the original stays visible, marked
//                             superseded.
//
// TRUST RULES (ADR-0002 §4/§5, ADR-0004, contract §6):
//   - actor + time are server-authoritative: actorPartyId comes from the session,
//     occurredAt from the server clock — never the body.
//   - Every transition is ONE ledger.append_event in the SAME transaction as its
//     projection write. No silent projection-only transition.
//   - proposer-vs-reviewer is resolved from the plan_version row
//     (proposed_by_party_id), never the request. REVIEW_PLAN denies the proposer
//     (via can()'s two-sided rule + proposedByPartyId). PROPOSE_PLAN/withdraw is
//     the proposer's own action, checked against proposed_by_party_id here.
//   - Freeze is DB-enforced (stage_freeze_guard trigger); the service mirrors it.
//   - None of these events move the budget — B3 owns the money.
import { randomUUID } from 'node:crypto';
import { ACTION, DomainError } from './ports.mjs';

const now = () => new Date().toISOString();

// The only editable fields on a StageEdit (contract §5): dates + money only. No
// structural (WBS/name/position) edits in B2.
// Forbidden structural keys: D12a cannot restructure the WBS in B2.
const STAGE_EDIT_FORBIDDEN = ['id', 'name', 'position', 'parentId', 'trade', 'importId'];

function normalizeCents(v) {
  if (!Number.isInteger(v)) {
    throw new DomainError(400, 'invalid_cost', 'plannedCostCents must be an integer (cents)');
  }
  return v;
}

function normalizeDate(v, field) {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new DomainError(400, `invalid_${field}`, `${field} must be a YYYY-MM-DD date or null`);
  }
  return v;
}

// Parents-before-children DFS pre-order over the WBS stage rows, so a fork can
// insert parent stages before their children (the stage.plan_version_id FK plus
// the self-referential parent FK both need an existing row). Tree-safe: children
// are visited only via their parent, so no stage is emitted before its parent.
function topoOrder(stages) {
  const childrenOf = new Map();
  for (const s of stages) {
    if (s.parent_id != null) {
      if (!childrenOf.has(s.parent_id)) childrenOf.set(s.parent_id, []);
      childrenOf.get(s.parent_id).push(s);
    }
  }
  const order = [];
  const roots = stages.filter((s) => s.parent_id == null).sort((a, b) => a.position - b.position);
  const visit = (s) => {
    order.push(s);
    for (const c of childrenOf.get(s.id) ?? []) visit(c);
  };
  for (const root of roots) visit(root);
  return order;
}

export function createPlanVersionService({ store, ledger, identity }) {
  if (!store || !ledger || !identity) {
    throw new Error('createPlanVersionService requires { store, ledger, identity } ports');
  }

  async function getVersionOr404(versionId) {
    const v = await store.getPlanVersion(versionId);
    if (!v) throw new DomainError(404, 'not_found', 'plan version not found');
    return v;
  }

  // The reviewer is "the other party" — resolved from the version row, never the
  // request (contract §6). authorizes REVIEW_PLAN; can() denies the proposer.
  async function authorizeReview(version, actorPartyId) {
    return identity.authorize({
      actorPartyId,
      action: ACTION.REVIEW_PLAN,
      projectId: version.project_id,
      proposedByPartyId: version.proposed_by_party_id,
    });
  }

  // PROPOSE_PLAN / withdraw is the proposer's own action (contract §6). The
  // capability check runs through the authorizer; the `=== proposed_by_party_id`
  // pairing is the proposer-only guard, applied here (no way to pass the acting
  // party through can() for "same-as" — the row is the authority).
  async function authorizeProposer(version, actorPartyId) {
    await identity.authorize({
      actorPartyId,
      action: ACTION.PROPOSE_PLAN,
      projectId: version.project_id,
    });
    if (actorPartyId !== version.proposed_by_party_id) {
      throw new DomainError(403, 'forbidden', 'only the proposing party may withdraw this plan');
    }
  }

  // ── GET /projects/:projectId/plan (D11–D13) ────────────────────────────────
  async function getPlan(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);

    const versions = await store.listPlanVersions(projectId);
    const baseline = await store.getProjectBaseline(projectId);

    const open = versions.find((v) => v.status === 'proposed');
    // Zero open proposal → the agreed baseline is the plan. Return the accepted
    // version as `current` so the plan surface never disappears once both parties
    // agree (D13; LINA-215). The FE keys every affordance off `status`: anything
    // non-'proposed' renders read-only, so no contract change is needed.
    const fallbackAccepted = open ? null : versions.find((v) => v.status === 'accepted');
    const currentSource = open ?? fallbackAccepted ?? null;
    const others = versions.filter((v) => v !== currentSource);

    const view = async (v) => ({
      ...(await versionView(projectId, v)),
      stages: await stageTree(v.id),
      acceptances: await acceptanceViews(projectId, await store.listPlanAcceptances(v.id)),
    });

    const current = currentSource ? await view(currentSource) : null;
    const history = [];
    for (const v of others) {
      history.push({
        id: v.id,
        versionNo: v.version_no,
        status: v.status,
        sourceImportId: v.source_import_id,
        supersedesVersionId: v.supersedes_version_id,
        proposedByPartyId: v.proposed_by_party_id,
        createdAt: v.created_at,
        frozenAt: v.frozen_at,
        acceptances: await acceptanceViews(projectId, await store.listPlanAcceptances(v.id)),
      });
    }
    history.sort((a, b) => a.versionNo - b.versionNo);

    return {
      baseline: baseline
        ? { planVersionId: baseline.plan_version_id, versionNo: baseline.version_no, frozenAt: baseline.frozen_at }
        : null,
      current,
      history,
    };
  }

  // The version envelope + its acceptance stamps, plus each party's role (for the
  // "who has stamped / who is awaited" banner, D11/D13).
  async function versionView(projectId, v) {
    return {
      id: v.id,
      versionNo: v.version_no,
      status: v.status,
      sourceImportId: v.source_import_id,
      supersedesVersionId: v.supersedes_version_id,
      proposedByPartyId: v.proposed_by_party_id,
      createdAt: v.created_at,
      frozenAt: v.frozen_at,
    };
  }

  // The WBS stage tree for a version, rooted at top-level actions (parent_id null),
  // children nested. Dates preserved as plain date strings.
  async function stageTree(versionId) {
    const stages = await store.listStagesByPlanVersion(versionId);
    const roots = stages.filter((s) => s.parent_id == null).sort((a, b) => a.position - b.position);
    const childrenOf = new Map();
    for (const s of stages) {
      if (s.parent_id != null) {
        if (!childrenOf.has(s.parent_id)) childrenOf.set(s.parent_id, []);
        childrenOf.get(s.parent_id).push(s);
      }
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position);

    const node = (s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      trade: s.trade ?? null,
      plannedStartDate: s.planned_start_date ?? null,
      plannedEndDate: s.planned_end_date ?? null,
      plannedCostCents: s.planned_cost_cents ?? null,
      children: (childrenOf.get(s.id) ?? []).map(node),
    });
    return roots.map(node);
  }

  async function acceptanceViews(projectId, acceptances) {
    const out = [];
    for (const a of acceptances) {
      const role = (await identity.roleOf?.(projectId, a.party_id)) ?? null;
      out.push({ partyId: a.party_id, role, kind: a.kind, stampedAt: a.stamped_at });
    }
    return out;
  }

  // ── POST …:withdraw (D11) — proposer only; terminal ───────────────────────
  async function withdraw(versionId, actorPartyId) {
    const version = await getVersionOr404(versionId);
    await authorizeProposer(version, actorPartyId);
    if (version.status !== 'proposed') {
      throw new DomainError(409, 'not_proposed',
        'only an open (proposed) plan may be withdrawn');
    }

    const occurredAt = now();
    await store.transaction(async (tx) => {
      await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_withdrawn',
        actorPartyId,
        occurredAt,
        payload: { planVersionId: version.id, versionNo: version.version_no },
      });
      await store.updatePlanVersionStatus(tx, version.id, { status: 'withdrawn' });
    });

    return { status: 'withdrawn' };
  }

  // ── POST …:accept (D12/D13) — reviewer; idempotent-by-state; 2nd stamp freezes ─
  async function accept(versionId, actorPartyId) {
    const version = await getVersionOr404(versionId);
    await authorizeReview(version, actorPartyId);

    // Idempotent-by-state (contract §5): a party accepting a version it already
    // stamped returns the current state and writes nothing.
    const existing = await store.getPlanAcceptance(version.id, actorPartyId);
    if (existing) {
      if (version.status === 'accepted') {
        const baseline = await store.getProjectBaseline(version.project_id);
        return {
          status: 'accepted',
          baseline: baseline
            ? { planVersionId: baseline.plan_version_id, versionNo: baseline.version_no, frozenAt: baseline.frozen_at }
            : null,
        };
      }
      throw new DomainError(409, 'already_stamped',
        'this party has already taken an action on this plan version');
    }
    if (version.status !== 'proposed') {
      throw new DomainError(409, 'not_proposed',
        'only an open (proposed) plan may be accepted');
    }

    const occurredAt = now();
    const acceptance = { id: randomUUID(), plan_version_id: version.id };
    let baseline = null;

    await store.transaction(async (tx) => {
      // 1. The reviewer's acceptance stamp ledgered first (its audit_event_id is
      //    needed by the plan_acceptance row — append-only, INSERT only).
      const event = await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_accepted',
        actorPartyId,
        occurredAt,
        payload: { planVersionId: version.id, versionNo: version.version_no, kind: 'accepted' },
      });

      // 2. The acceptance projection (append-only).
      await store.insertPlanAcceptance(tx, {
        id: acceptance.id,
        plan_version_id: version.id,
        project_id: version.project_id,
        party_id: actorPartyId,
        kind: 'accepted',
        stamped_at: occurredAt,
        audit_event_id: event.id,
      });

      // 3. Dual acceptance → freeze. A version freezes only when BOTH the
      //    proposer's authorship stamp ('proposed') AND the reviewer's acceptance
      //    stamp ('accepted') exist (contract §2). On that second stamp, in ONE
      //    transaction: accept the version, append baseline_frozen, upsert the
      //    project_baseline pointer.
      const stamps = await store.listPlanAcceptances(version.id);
      const hasProposer = stamps.some((s) => s.kind === 'proposed');
      const hasReviewer = stamps.some((s) => s.kind === 'accepted');
      if (hasProposer && hasReviewer) {
        await store.updatePlanVersionStatus(tx, version.id, { status: 'accepted', frozenAt: occurredAt });

        const frozen = await ledger.append(tx, {
          projectId: version.project_id,
          type: 'baseline_frozen',
          actorPartyId,
          occurredAt,
          payload: {
            planVersionId: version.id,
            versionNo: version.version_no,
            proposedByPartyId: version.proposed_by_party_id,
            acceptedByPartyId: actorPartyId,
          },
        });

        await store.upsertProjectBaseline(tx, {
          project_id: version.project_id,
          plan_version_id: version.id,
          version_no: version.version_no,
          frozen_at: occurredAt,
          baseline_audit_event_id: frozen.id,
        });
        baseline = {
          planVersionId: version.id,
          versionNo: version.version_no,
          frozenAt: occurredAt,
        };
      }
    });

    if (baseline) return { status: 'accepted', baseline };
    // First stamp only — awaiting the other party's acceptance.
    return { status: 'proposed' };
  }

  // ── POST …:reject (D12) — reviewer; terminal ──────────────────────────────
  async function reject(versionId, actorPartyId, { reason } = {}) {
    const version = await getVersionOr404(versionId);
    await authorizeReview(version, actorPartyId);
    if (version.status !== 'proposed') {
      throw new DomainError(409, 'not_proposed',
        'only an open (proposed) plan may be rejected');
    }
    if (reason != null && (typeof reason !== 'string' || reason.length > 2000)) {
      throw new DomainError(400, 'invalid_reason', 'reason must be a string ≤ 2000 chars or null');
    }

    const occurredAt = now();
    await store.transaction(async (tx) => {
      await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_rejected',
        actorPartyId,
        occurredAt,
        payload: { planVersionId: version.id, versionNo: version.version_no, reason: reason ?? null },
      });
      await store.updatePlanVersionStatus(tx, version.id, { status: 'rejected' });
    });

    return { status: 'rejected' };
  }

  // ── POST …:request-changes (D12a) — reviewer forks a new version ───────────
  async function requestChanges(versionId, actorPartyId, { stages } = {}) {
    const version = await getVersionOr404(versionId);
    await authorizeReview(version, actorPartyId);
    if (version.status !== 'proposed') {
      throw new DomainError(409, 'not_proposed',
        'only an open (proposed) plan may be changed');
    }

    const edits = validateStageEdits(stages);

    // The edits must reference stages that belong to THIS version.
    const versionStages = await store.listStagesByPlanVersion(version.id);
    const versionStageIds = new Set(versionStages.map((s) => s.id));
    for (const e of edits.keys()) {
      if (!versionStageIds.has(e)) {
        throw new DomainError(400, 'unknown_stage',
          'a requested edit references a stage that is not in this plan version');
      }
    }

    const occurredAt = now();
    const newVersionId = randomUUID();
    const newVersionNo = await store.nextPlanVersionNo(version.project_id);

    await store.transaction(async (tx) => {
      // 1. The reviewer's request event, then the fork's plan_proposed (two events
      //    in this one transaction — contract §4). plan_proposed's stageCount rides
      //    the payload so the hash reproduces on verify.
      await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_change_requested',
        actorPartyId,
        occurredAt,
        payload: {
          fromVersionId: version.id,
          fromVersionNo: version.version_no,
          newVersionId,
          newVersionNo,
        },
      });

      const stageCount = versionStages.length;
      const proposed = await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_proposed',
        actorPartyId,
        occurredAt,
        payload: {
          planVersionId: newVersionId,
          versionNo: newVersionNo,
          sourceImportId: null,
          supersedesVersionId: version.id,
          stageCount,
        },
      });

      // 2. The original is superseded BEFORE the fork is inserted — the DB's
      //    plan_version_one_open_per_project partial unique index admits exactly
      //    ONE 'proposed' version per project, so the fork must not exist while
      //    the original is still open (it stays visible in history; LINA-215).
      await store.updatePlanVersionStatus(tx, version.id, { status: 'superseded' });

      // 3. The new version envelope — authored by the REVIEWER (roles swap, D12a),
      //    superseding the original.
      await store.insertPlanVersion(tx, {
        id: newVersionId,
        project_id: version.project_id,
        version_no: newVersionNo,
        status: 'proposed',
        source_import_id: null,
        supersedes_version_id: version.id,
        proposed_by_party_id: actorPartyId,
        created_at: occurredAt,
        frozen_at: null,
      });

      // 4. The fork author's authorship stamp ('proposed') on the new version.
      await store.insertPlanAcceptance(tx, {
        id: randomUUID(),
        plan_version_id: newVersionId,
        project_id: version.project_id,
        party_id: actorPartyId,
        kind: 'proposed',
        stamped_at: occurredAt,
        audit_event_id: proposed.id,
      });

      // 5. Fork the stages: the original version's STAGES ARE UNTOUCHED (it stays
      //    visible underneath, D12a) — a copy bound to the new version has the
      //    dates-and-money-only patch applied, structure (names/positions/WBS)
      //    preserved. The copy is inserted with its REMAPPED parent_id, in
      //    parents-before-children order (the DB FK requires an existing parent),
      //    so no post-insert parent UPDATE (and none past the store's UPDATABLE
      //    whitelist) is needed.
      const oldToNew = new Map();
      for (const s of versionStages) oldToNew.set(s.id, randomUUID());

      for (const s of topoOrder(versionStages)) {
        const newId = oldToNew.get(s.id);
        await store.insertStage(tx, {
          id: newId,
          project_id: version.project_id,
          name: s.name,
          position: s.position,
          parent_id: s.parent_id != null ? oldToNew.get(s.parent_id) : null,
          trade: s.trade,
          import_id: null,
          source_row_ref: s.source_row_ref,
          scope_note: s.scope_note,
          planned_start_date: s.planned_start_date,
          planned_end_date: s.planned_end_date,
          planned_cost_cents: s.planned_cost_cents,
          plan_version_id: newVersionId,
          created_at: occurredAt,
          updated_at: occurredAt,
        });

        // Apply the dates-and-money-only patch to the new stage.
        const patch = {};
        if (edits.has(s.id)) {
          const e = edits.get(s.id);
          if (e.plannedStartDate !== undefined) patch.planned_start_date = e.plannedStartDate;
          if (e.plannedEndDate !== undefined) patch.planned_end_date = e.plannedEndDate;
          if (e.plannedCostCents !== undefined) patch.planned_cost_cents = e.plannedCostCents;
        }
        if (Object.keys(patch).length > 0) {
          await store.updateStage(tx, newId, { ...patch, updated_at: occurredAt });
        }
      }
    });

    return { newVersionId, versionNo: newVersionNo, status: 'proposed' };
  }

  // Validate the StageEdit patch: an array of { stageId, plannedStartDate?,
  // plannedEndDate?, plannedCostCents? }; returns a Map(stageId → clean edit).
  // Dates and money only; any other key, or a non-array/empty body, is a 400.
  function validateStageEdits(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new DomainError(400, 'invalid_stages', 'stages is required (a non-empty array of edits)');
    }
    const edits = new Map();
    for (const raw of stages) {
      if (!raw || typeof raw !== 'object') {
        throw new DomainError(400, 'invalid_stages', 'each stage edit must be an object');
      }
      const { stageId } = raw ?? {};
      if (!stageId || typeof stageId !== 'string') {
        throw new DomainError(400, 'invalid_stages', 'each stage edit requires a stageId');
      }
      const forbidden = STAGE_EDIT_FORBIDDEN.filter((k) => k in (raw ?? {}));
      if (forbidden.length > 0) {
        throw new DomainError(400, 'invalid_stages',
          `structural stage fields are not editable in B2: ${forbidden.join(', ')}`);
      }
      const clean = {};
      if (raw.plannedStartDate !== undefined) clean.plannedStartDate = normalizeDate(raw.plannedStartDate, 'plannedStartDate');
      if (raw.plannedEndDate !== undefined) clean.plannedEndDate = normalizeDate(raw.plannedEndDate, 'plannedEndDate');
      if (raw.plannedCostCents !== undefined) clean.plannedCostCents = normalizeCents(raw.plannedCostCents);
      if (Object.keys(clean).length === 0) {
        throw new DomainError(400, 'invalid_stages',
          'each stage edit must change a date or the planned cost');
      }
      edits.set(stageId, clean);
    }
    return edits;
  }

  // ── POST …/plan-versions:author (LINA-228, ADR-0017) ──────────────────────
  // Direct plan authoring — the "build it here" route (pen D7 Route 2). Mirrors
  // the import :confirm spine (plan-import.mjs) exactly, minus the spreadsheet
  // parser and the plan_import header: a WBS tree authored in the browser lands
  // as a proposed v1 (source_import_id = null) the OTHER party reviews, so the
  // tamper-evidence discipline is identical — one plan_proposed event in the same
  // transaction as the projection. No new migration, no new status.
  //
  // Contract: docs/architecture/slice-direct-plan-authoring-contract.md.
  async function authorPlan(projectId, actorPartyId, { stages } = {}) {
    // Either party may author (PROPOSE_PLAN is on both roles, ADR-0004 / ADR-0017
    // §3); the review flow is self-protecting (REVIEW_PLAN denies the proposer).
    await identity.authorize({ actorPartyId, action: ACTION.PROPOSE_PLAN, projectId });

    const order = validateAuthoredStages(stages);

    // One open proposal per project (B2 contract §1). Checked here for a clean
    // 409, and enforced by the plan_version_one_open_per_project unique index —
    // a racing insert that trips it maps to the same 409 below.
    if (await store.getOpenPlanVersion(projectId)) {
      throw new DomainError(409, 'open_plan_exists',
        'this project already has an open (proposed) plan — withdraw it before authoring a new plan');
    }

    const occurredAt = now();
    const versionId = randomUUID();
    // Deterministic ids up front so the pre-order stays stable across the append.
    const ids = order.map(() => randomUUID());

    const write = async (tx) => {
      const versionNo = await store.nextPlanVersionNo(projectId);

      // 1. The one proposal event, appended FIRST: the authorship stamp
      //    (append-only, INSERT only) needs its audit_event_id.
      const proposed = await ledger.append(tx, {
        projectId,
        type: 'plan_proposed',
        actorPartyId,
        occurredAt,
        payload: {
          planVersionId: versionId,
          versionNo,
          sourceImportId: null,
          supersedesVersionId: null,
          stageCount: order.length,
        },
      });

      // 2. The version envelope — authored from scratch, no import, no supersede.
      await store.insertPlanVersion(tx, {
        id: versionId,
        project_id: projectId,
        version_no: versionNo,
        status: 'proposed',
        source_import_id: null,
        supersedes_version_id: null,
        proposed_by_party_id: actorPartyId,
        created_at: occurredAt,
        frozen_at: null,
      });

      // 3. The author's authorship ('proposed') stamp.
      await store.insertPlanAcceptance(tx, {
        id: randomUUID(),
        plan_version_id: versionId,
        project_id: projectId,
        party_id: actorPartyId,
        kind: 'proposed',
        stamped_at: occurredAt,
        audit_event_id: proposed.id,
      });

      // 4. Stage rows, parents before children (pre-order), positions appended
      //    after any existing stages so plan order stays deterministic.
      const base = await store.maxStagePosition(projectId);
      let rootCount = 0;
      for (let i = 0; i < order.length; i += 1) {
        const node = order[i];
        if (node.parentIndex == null) rootCount += 1;
        await store.insertStage(tx, {
          id: ids[i],
          project_id: projectId,
          name: node.name,
          position: base + i + 1,
          parent_id: node.parentIndex == null ? null : ids[node.parentIndex],
          trade: node.trade,
          import_id: null,
          source_row_ref: null,
          scope_note: null,
          planned_start_date: node.plannedStartDate,
          planned_end_date: node.plannedEndDate,
          planned_cost_cents: node.plannedCostCents,
          plan_version_id: versionId,
          created_at: occurredAt,
          updated_at: occurredAt,
        });
      }

      return {
        planVersionId: versionId,
        versionNo,
        status: 'proposed',
        stageCount: order.length,
        rootCount,
        auditEventId: proposed.id,
      };
    };

    try {
      return await store.transaction(write);
    } catch (err) {
      // A concurrent author/import that won the one-open race trips the partial
      // unique index — surface it as the same clean 409, never a 500.
      if (err && err.code === '23505' && err.constraint === 'plan_version_one_open_per_project') {
        throw new DomainError(409, 'open_plan_exists',
          'this project already has an open (proposed) plan — withdraw it before authoring a new plan');
      }
      throw err;
    }
  }

  // Validate the authored WBS tree and flatten it to a pre-order list with a
  // parentIndex back-pointer (parents always precede their children). Two levels
  // only — a sub-action may not carry children (the model's self-ref FK permits
  // deeper nesting; this slice does not, matching the B1 parser).
  function validateAuthoredStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new DomainError(400, 'empty_plan', 'stages is required (a non-empty array of actions)');
    }
    const order = [];
    const pushNode = (raw, parentIndex, depth) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new DomainError(400, 'invalid_stages', 'each stage must be an object');
      }
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) {
        throw new DomainError(400, 'invalid_name', 'every stage needs a non-empty name');
      }
      if (name.length > 200) {
        throw new DomainError(400, 'invalid_name', 'a stage name must be ≤ 200 chars');
      }
      let trade = null;
      if (raw.trade != null) {
        if (typeof raw.trade !== 'string' || raw.trade.length > 120) {
          throw new DomainError(400, 'invalid_stages', 'trade must be a string ≤ 120 chars or null');
        }
        trade = raw.trade.trim() || null;
      }
      const index = order.length;
      order.push({
        name,
        parentIndex,
        trade,
        plannedStartDate: normalizeDate(raw.plannedStartDate ?? null, 'plannedStartDate'),
        plannedEndDate: normalizeDate(raw.plannedEndDate ?? null, 'plannedEndDate'),
        plannedCostCents: raw.plannedCostCents == null ? null : normalizeCents(raw.plannedCostCents),
      });
      const children = raw.children;
      if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) {
          throw new DomainError(400, 'invalid_stages', 'children must be an array');
        }
        if (depth >= 1 && children.length > 0) {
          throw new DomainError(400, 'too_deep',
            'the plan is two levels only — a sub-action cannot have its own children');
        }
        for (const child of children) pushNode(child, index, depth + 1);
      }
    };
    for (const root of stages) pushNode(root, null, 0);
    return order;
  }

  return { getPlan, withdraw, accept, reject, requestChanges, authorPlan };
}
