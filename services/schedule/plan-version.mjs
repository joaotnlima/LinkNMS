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
const STAGE_EDIT_FORBIDDEN = ['id', 'name', 'position', 'parentId', 'trade', 'assigneePartyId', 'importId'];

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

// `phases` (the phase service, LINA-278) is OPTIONAL — same default-to-noop
// contract as createScheduleService: omit it and the sign-off lock is not
// applied (unit fixtures build this service directly). The deployed target
// always injects it (services/composition.mjs), asserted by composition.test.mjs.
export function createPlanVersionService({ store, ledger, identity, phases = null }) {
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

    // A DRAFT is the author's private workspace (LINA-230): it is surfaced as
    // `current` to its author ONLY, and only when no open proposal stands in
    // front of it. The other party never sees a draft — not as current, not in
    // history. Everything numbered (proposed and onward) is the shared record.
    const numbered = versions.filter((v) => v.status !== 'draft');
    const liveDraft = versions.find((v) => v.status === 'draft') ?? null;

    const open = numbered.find((v) => v.status === 'proposed');
    // Zero open proposal → either the author's own draft (editable, private) or,
    // failing that, the agreed baseline is the plan. Return the accepted version
    // as `current` so the plan surface never disappears once both parties agree
    // (D13; LINA-215). The FE keys every affordance off `status`: anything
    // non-'proposed' renders read-only (a draft gets its own author-only editing
    // controls), so no further contract change is needed.
    let currentSource = null;
    if (open) {
      currentSource = open;
    } else if (liveDraft && actorPartyId && actorPartyId === liveDraft.proposed_by_party_id) {
      currentSource = liveDraft;
    } else {
      currentSource = numbered.find((v) => v.status === 'accepted') ?? null;
    }
    // History is the shared record only — a draft is never tidied into it.
    const others = numbered.filter((v) => v !== currentSource);

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
  // children nested. Dates preserved as plain date strings. Each node carries its
  // resolved predecessor stage ids as `dependsOn` (ADR-0017 annex 2, LINA-233) AND
  // the same edges typed as `dependencies` (ADR-0020, LINA-252). The legacy
  // `dependsOn: string[]` is DUAL-EMITTED next to `dependencies: [{ on, type }]`
  // until the FE consumes the typed shape in prod — never break the read shape
  // between the BE and FE merges.
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

    const depsByStage = new Map();
    for (const d of await store.listStageDependenciesByPlanVersion(versionId)) {
      if (!depsByStage.has(d.stage_id)) depsByStage.set(d.stage_id, []);
      depsByStage.get(d.stage_id).push(d);
    }

    const node = (s) => ({
      id: s.id,
      key: s.key ?? null,
      name: s.name,
      position: s.position,
      trade: s.trade ?? null,
      assigneePartyId: s.assignee_party_id ?? null,
      description: s.description ?? null,
      plannedStartDate: s.planned_start_date ?? null,
      plannedEndDate: s.planned_end_date ?? null,
      plannedCostCents: s.planned_cost_cents ?? null,
      dependsOn: (depsByStage.get(s.id) ?? []).map((d) => d.depends_on_stage_id),
      dependencies: (depsByStage.get(s.id) ?? []).map((d) => ({
        on: d.depends_on_stage_id,
        type: d.dep_type,
      })),
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
          assignee_party_id: s.assignee_party_id,
          import_id: null,
          source_row_ref: s.source_row_ref,
          scope_note: s.scope_note,
          description: s.description,
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

  // Re-insert an authored WBS tree's stage rows onto a version, parents before
  // children (pre-order), positions appended after any existing stages so plan
  // order stays deterministic. Returns { rootCount, ids } — the freshly-assigned
  // stage ids in pre-order (i === the node's order index), so `:author` can
  // resolve each node's `dependsOn` predecessors to ids in the SAME transaction,
  // exactly as import resolves `source_row_ref` (plan-import.mjs §6/§8).
  async function insertAuthoredStages(tx, projectId, versionId, order, occurredAt) {
    const ids = order.map(() => randomUUID());
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
        assignee_party_id: node.assigneePartyId,
        import_id: null,
        source_row_ref: null,
        key: node.key ?? null,
        scope_note: null,
        description: node.description,
        planned_start_date: node.plannedStartDate,
        planned_end_date: node.plannedEndDate,
        planned_cost_cents: node.plannedCostCents,
        plan_version_id: versionId,
        created_at: occurredAt,
        updated_at: occurredAt,
      });
    }
    return { rootCount, ids };
  }

  // Validate every distinct assigneePartyId in the authored tree is a party on
  // the project (membership check via the identity port). Rejects with 400
  // unknown_assignee for any party that is not a member — no cross-schema FK;
  // the identity port's roleOf is the source of truth (ADR-0006 §1).
  async function assertAssigneesOnProject(projectId, order) {
    const distinct = new Set();
    for (const node of order) {
      if (node.assigneePartyId != null) distinct.add(node.assigneePartyId);
    }
    for (const pid of distinct) {
      const role = await identity.roleOf(projectId, pid);
      if (!role) {
        throw new DomainError(400, 'unknown_assignee',
          'assigneePartyId must reference a party that is a member of this project');
      }
    }
  }

  // ── POST …/plan-versions:author (LINA-228/LINA-230, ADR-0017 annex) ────────
  // Direct plan authoring — the "build it here" route (pen D7 Route 2). Authoring
  // is PRIVATE drafting: the WBS tree authored in the browser lands as a DRAFT
  // (version_no null, source_import_id null), NOT a proposal. The other party sees
  // nothing; no approval is requested. Saving again REPLACES the single draft in
  // place (one draft per project). The tamper-evidence discipline is unchanged —
  // every save is one `plan_drafted` event in the same transaction as the
  // projection write. Sending for approval is a separate act (`:propose`).
  //
  // No plan_acceptance stamp is written while drafting: plan_acceptance is
  // append-only and its UNIQUE(plan_version_id, party_id) + the freeze pairing
  // mean the drafter's authorship stamp must be the 'proposed' stamp written at
  // :propose. Draft authorship is recorded by the plan_drafted event + the
  // version's proposed_by_party_id (the "author").
  //
  // Contract: docs/architecture/slice-direct-plan-authoring-contract.md.
  async function authorPlan(projectId, actorPartyId, { stages } = {}) {
    // Either party may author (PROPOSE_PLAN is on both roles, ADR-0004 / ADR-0017
    // §3); the review flow is self-protecting (REVIEW_PLAN denies the proposer).
    await identity.authorize({ actorPartyId, action: ACTION.PROPOSE_PLAN, projectId });

    // Sign-off lock (LINA-297; ADR-0023 §8): once the execution plan is signed
    // off it is immutable — authoring a new/revised plan is a change order
    // (ADR-0014), not a fresh draft. 409 plan_locked before any write.
    if (phases) await phases.assertPlanEditable(projectId);

    const order = validateAuthoredStages(stages);
    await assertAssigneesOnProject(projectId, order);

    // Can't draft while a proposal is live: a single authoring thread per project
    // (B2 contract §1). Withdraw the open proposal first.
    if (await store.getOpenPlanVersion(projectId)) {
      throw new DomainError(409, 'open_plan_exists',
        'this project already has an open (proposed) plan — withdraw it before authoring a new plan');
    }

    const existingDraft = await store.getDraftPlanVersion(projectId);
    // A draft is its author's private workspace — only the drafter may replace it.
    if (existingDraft && existingDraft.proposed_by_party_id !== actorPartyId) {
      throw new DomainError(409, 'draft_exists',
        'this project already has a plan being drafted');
    }

    const occurredAt = now();
    const versionId = existingDraft ? existingDraft.id : randomUUID();

    const write = async (tx) => {
      // The draft event, one per save (an honest "saved at T" on the ledger). It
      // carries no version_no — a draft is unnumbered until it is proposed.
      const drafted = await ledger.append(tx, {
        projectId,
        type: 'plan_drafted',
        actorPartyId,
        occurredAt,
        payload: {
          planVersionId: versionId,
          sourceImportId: null,
          stageCount: order.length,
        },
      });

      if (existingDraft) {
        // Re-save: replace the draft's stages (and their predecessor graph) in
        // place. Dependencies go FIRST — the stage DELETE would otherwise fail on
        // the FK `stage_dependency.stage_id → stage.id`. Both deletes are
        // trigger-guarded: only a draft's rows are deletable; a frozen
        // baseline's rows (and stages) never are.
        await store.deleteStageDependenciesByPlanVersion(tx, versionId);
        await store.deleteStagesByPlanVersion(tx, versionId);
      } else {
        // First save: the draft envelope — unnumbered, no import, no supersede.
        await store.insertPlanVersion(tx, {
          id: versionId,
          project_id: projectId,
          version_no: null,
          status: 'draft',
          source_import_id: null,
          supersedes_version_id: null,
          proposed_by_party_id: actorPartyId,
          created_at: occurredAt,
          frozen_at: null,
        });
      }

      // The stage rows (ids ride the same tx), then the predecessor graph — both
      // resolved from the author's keys to the freshly-inserted ids HERE, in the
      // same transaction as the stages and the single plan_drafted event. A
      // dependency edit is part of "the draft saved at T"; no separate ledger
      // event (ADR-0017 annex 2 §1).
      const { rootCount, ids } = await insertAuthoredStages(tx, projectId, versionId, order, occurredAt);
      for (let i = 0; i < order.length; i += 1) {
        for (const dep of order[i].deps) {
          await store.insertStageDependency(tx, ids[i], ids[dep.pred], dep.type);
        }
      }

      return {
        planVersionId: versionId,
        versionNo: null,
        status: 'draft',
        stageCount: order.length,
        rootCount,
        auditEventId: drafted.id,
      };
    };

    try {
      return await store.transaction(write);
    } catch (err) {
      // A concurrent author that won the one-draft race trips the partial unique
      // index — surface it as a clean 409, never a 500.
      if (err && err.code === '23505' && err.constraint === 'plan_version_one_draft_per_project') {
        throw new DomainError(409, 'draft_exists',
          'this project already has a plan being drafted');
      }
      throw err;
    }
  }

  // ── POST …/plan-versions/:id:propose (LINA-230) — "Send for approval" ──────
  // The explicit second act the founder asked for: a draft → proposed, in one
  // transaction. This is where a plan FIRST becomes visible to the other party
  // and where it FIRST requests approval. version_no is assigned here (the draft
  // was unnumbered), one plan_proposed event is appended, the status flips, and
  // the drafter's single authorship ('proposed') stamp is written — the same
  // stamp that later pairs with the reviewer's accept to freeze the baseline.
  async function proposePlan(versionId, actorPartyId) {
    const version = await getVersionOr404(versionId);
    // PROPOSE_PLAN is the proposer's own action; only the drafter may send their
    // own draft for approval (same row-is-authority rule as withdraw).
    await identity.authorize({ actorPartyId, action: ACTION.PROPOSE_PLAN, projectId: version.project_id });
    if (actorPartyId !== version.proposed_by_party_id) {
      throw new DomainError(403, 'forbidden', 'only the drafting party may send this plan for approval');
    }
    if (version.status !== 'draft') {
      throw new DomainError(409, 'not_draft',
        'only a draft may be sent for approval');
    }
    // Sign-off lock (LINA-297): a signed_off execution plan cannot receive a new
    // proposal — the edit must route through a change order (ADR-0014).
    if (phases) await phases.assertPlanEditable(version.project_id);

    const occurredAt = now();

    const write = async (tx) => {
      const versionNo = await store.nextPlanVersionNo(version.project_id);
      const stageCount = await store.stageCountByPlanVersion(version.id);

      // 1. The proposal event, appended FIRST: the authorship stamp (append-only,
      //    INSERT only) needs its audit_event_id. stageCount rides the payload so
      //    the hash reproduces on verify.
      const proposed = await ledger.append(tx, {
        projectId: version.project_id,
        type: 'plan_proposed',
        actorPartyId,
        occurredAt,
        payload: {
          planVersionId: version.id,
          versionNo,
          sourceImportId: null,
          supersedesVersionId: null,
          stageCount,
        },
      });

      // 2. Flip draft → proposed and stamp the version number in one mutation.
      await store.updatePlanVersionStatus(tx, version.id, { status: 'proposed', versionNo });

      // 3. The author's authorship ('proposed') stamp — the first of the two that
      //    freeze the baseline.
      await store.insertPlanAcceptance(tx, {
        id: randomUUID(),
        plan_version_id: version.id,
        project_id: version.project_id,
        party_id: actorPartyId,
        kind: 'proposed',
        stamped_at: occurredAt,
        audit_event_id: proposed.id,
      });

      return {
        planVersionId: version.id,
        versionNo,
        status: 'proposed',
        auditEventId: proposed.id,
      };
    };

    try {
      return await store.transaction(write);
    } catch (err) {
      // A racing import/author that opened a proposal first trips the one-open
      // index when this draft flips to proposed — a clean 409, never a 500.
      if (err && err.code === '23505' && err.constraint === 'plan_version_one_open_per_project') {
        throw new DomainError(409, 'open_plan_exists',
          'this project already has an open (proposed) plan — withdraw it before sending this one for approval');
      }
      throw err;
    }
  }

  // Validate the authored WBS tree and flatten it to a pre-order list with a
  // parentIndex back-pointer (parents always precede their children). Three
  // levels at most — Action → Sub-action → Sub-sub-action; a node at depth 2 may
  // not carry children (LINA-238, ADR-0019: the founder wanted depth-3 in
  // authoring; task_type was declined). The model's self-ref FK permits unbounded
  // nesting, so the cap is enforced here in application code. The B1 import parser
  // stays two-level by construction (its sheet has only Action/Sub-action columns)
  // and templates stay a two-level names-only scaffold (ADR-0018) — both deliberate.
  //
  // Two optional per-node fields ride the payload (ADR-0017 annex 2, LINA-233):
  //   - `key` — a stable author-local id for the node WITHIN this payload (the
  //     FE's local row id). Unique across the payload; used for resolution and,
  //     since LINA-249, PERSISTED on the stage row as `schedule.stage.key` — the
  //     stable identity the task-workspace comments/attachments anchor on, so
  //     they survive a draft re-save and a version bump.
  //   - `dependsOn` — an array of keys this node's stage must follow (its
  //     predecessors). Cross-level deps are permitted (any distinct stage is a
  //     valid target). Each key is resolved to a predecessor flat-list index
  //     HERE, purely over the in-memory graph and BEFORE any write:
  //       400 self_dependency     a node lists itself as a predecessor
  //       400 unknown_dependency  a dependsOn key matches no node in the payload
  //       400 duplicate_key       a key appears more than once in the payload
  //       409 dependency_cycle    the resolved graph has a cycle (DFS back-edge)
  //     Cycle validation is total — the whole graph is revalidated on every save,
  //     so a draft can never be saved in a cyclic state.
  const KEY_MAX = 200;
  // ADR-0020 (LINA-252) link types — one typed link per ordered stage pair.
  const DEP_TYPES = new Set(['starts_after', 'starts_with', 'ends_with']);

  // Resolve one `dependsOn` entry to { key, type }. Bare strings are the compat
  // alias for { key, type: 'starts_after' }; the object form carries the type
  // explicitly (missing type defaults to starts_after, the column default). An
  // unknown type is refused (400 invalid_dependency_type) before any resolution.
  function parseDepEntry(node, entry) {
    if (typeof entry === 'string') {
      if (entry === '' || entry.length > KEY_MAX) {
        throw new DomainError(400, 'invalid_stages',
          'a dependency key must be a non-empty string ≤ 200 chars');
      }
      return { key: entry, type: 'starts_after' };
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const key = entry.key;
      if (typeof key !== 'string' || key === '' || key.length > KEY_MAX) {
        throw new DomainError(400, 'invalid_stages',
          'a typed dependency needs a non-empty key ≤ 200 chars');
      }
      const type = entry.type == null ? 'starts_after' : entry.type;
      if (typeof type !== 'string' || !DEP_TYPES.has(type)) {
        throw new DomainError(400, 'invalid_dependency_type',
          `unknown dependency type "${type}" — must be starts_after, starts_with or ends_with`,
          { key, stage: { key: node.key, name: node.name } });
      }
      return { key, type };
    }
    throw new DomainError(400, 'invalid_stages',
      'dependsOn entries must be key strings or { key, type } objects');
  }

  function validateAuthoredStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new DomainError(400, 'empty_plan', 'stages is required (a non-empty array of actions)');
    }
    const order = [];
    const keyToIndex = new Map();
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
      let assigneePartyId = null;
      if (raw.assigneePartyId != null) {
        if (typeof raw.assigneePartyId !== 'string' || raw.assigneePartyId.length > 200) {
          throw new DomainError(400, 'invalid_assignee',
            'assigneePartyId must be a party id (string) or null');
        }
        const cleaned = raw.assigneePartyId.trim();
        if (!cleaned) throw new DomainError(400, 'invalid_assignee', 'assigneePartyId, when present, must not be empty');
        assigneePartyId = cleaned;
      }
      let description = null;
      if (raw.description != null) {
        if (typeof raw.description !== 'string') {
          throw new DomainError(400, 'invalid_stages', 'description must be a string or null');
        }
        if (raw.description.length > 4000) {
          throw new DomainError(400, 'invalid_stages', 'a stage description must be ≤ 4000 chars');
        }
        description = raw.description.trim() || null;
      }
      let key = null;
      if (raw.key != null) {
        if (typeof raw.key !== 'string' || raw.key === '' || raw.key.length > KEY_MAX) {
          throw new DomainError(400, 'invalid_stages',
            'key must be a non-empty string ≤ 200 chars or omitted');
        }
        key = raw.key;
        if (keyToIndex.has(key)) {
          throw new DomainError(400, 'duplicate_key',
            `duplicate key "${key}" — each key must be unique within the payload`);
        }
      }
      const index = order.length;
      keyToIndex.set(key, index);
      order.push({
        name,
        key,
        dependsOn: [],
        deps: [],
        rawDependsOn: raw.dependsOn,
        parentIndex,
        trade,
        assigneePartyId,
        description,
        plannedStartDate: normalizeDate(raw.plannedStartDate ?? null, 'plannedStartDate'),
        plannedEndDate: normalizeDate(raw.plannedEndDate ?? null, 'plannedEndDate'),
        plannedCostCents: raw.plannedCostCents == null ? null : normalizeCents(raw.plannedCostCents),
      });
      const children = raw.children;
      if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) {
          throw new DomainError(400, 'invalid_stages', 'children must be an array');
        }
        if (depth >= 2 && children.length > 0) {
          throw new DomainError(400, 'too_deep',
            'the plan is three levels deep at most — a sub-sub-action cannot have its own children');
        }
        for (const child of children) pushNode(child, index, depth + 1);
      }
    };
    for (const root of stages) pushNode(root, null, 0);

    // Keys are registered by the walk above — but a `dependsOn` may reference a
    // key that only appears LATER in the DFS pre-order, so resolution runs as a
    // second pass once the whole payload's key set is known. Since LINA-252
    // (ADR-0020) each entry is a bare key (compat alias for
    // `{ key, type: 'starts_after' }`) or `{ key, type }`; the type rides the
    // same in-memory edge into `insertStageDependency`.
    for (let i = 0; i < order.length; i += 1) {
      const node = order[i];
      const raw = node.rawDependsOn ?? [];
      if (!Array.isArray(raw)) {
        throw new DomainError(400, 'invalid_stages', 'dependsOn must be an array');
      }
      const seen = new Set();
      for (const entry of raw) {
        const { key: depKey, type: depType } = parseDepEntry(node, entry);
        if (seen.has(depKey)) {
          throw new DomainError(400, 'duplicate_dependency',
            `stage "${node.name}" lists "${depKey}" as a predecessor more than once`,
            { key: depKey, stage: { key: node.key, name: node.name } });
        }
        seen.add(depKey);
        if (node.key != null && depKey === node.key) {
          throw new DomainError(400, 'self_dependency',
            `stage "${node.name}" cannot depend on itself`,
            { stage: { key: node.key, name: node.name } });
        }
        const pred = keyToIndex.get(depKey);
        if (pred === undefined) {
          throw new DomainError(400, 'unknown_dependency',
            `stage "${node.name}" depends on "${depKey}", which is not a stage in this plan`,
            { key: depKey, stage: { key: node.key, name: node.name } });
        }
        node.dependsOn.push(pred);
        node.deps.push({ pred, type: depType });
      }
    }

    rejectDependencyCycles(order);
    return order;
  }

  // DFS (3-colour) back-edge detection over the resolved predecessor graph for
  // the ORDER built by validateAuthoredStages — purely in memory, total, before
  // any write. A cycle (e.g. A after B, B after A) is nonsensical and would break
  // any future auto-schedule, so it is refused outright, naming the stages on the
  // cycle for the FE to highlight.
  function rejectDependencyCycles(order) {
    const WHITE = 0; const GRAY = 1; const BLACK = 2;
    const colour = order.map(() => WHITE);
    const stack = [];
    for (let start = 0; start < order.length; start += 1) {
      if (colour[start] !== WHITE) continue;
      const visit = (i) => {
        colour[i] = GRAY;
        stack.push(i);
        for (const pred of order[i].dependsOn) {
          if (colour[pred] === GRAY) {
            // pred is on the current path — the segment pred → … → i, closed by
            // the back-edge i → pred, is the cycle.
            const from = stack.indexOf(pred);
            const cycle = stack.slice(from).map((idx) => ({
              key: order[idx].key,
              name: order[idx].name,
            }));
            throw new DomainError(409, 'dependency_cycle',
              `the dependency graph contains a cycle: ${cycle.map((s) => s.name).join(' → ')}`,
              { stages: cycle });
          }
          if (colour[pred] === WHITE) visit(pred);
        }
        colour[i] = BLACK;
        stack.pop();
      };
      visit(start);
    }
  }

  return { getPlan, withdraw, accept, reject, requestChanges, authorPlan, proposePlan };
}
