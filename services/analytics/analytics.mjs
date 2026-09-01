// Analytics facade — the domain-friendly API the R0 services call (LINA-55).
//
// Each method takes plain domain facts and:
//   1. builds the exact PostHog event shape (super-properties + event props per
//      LINA-28 §2.2/§2.3),
//   2. runs the hard PII guard (§3),
//   3. hands it to the injected sink,
//   4. swallows any error — analytics is best-effort and MUST NEVER fail or slow
//      a domain write (a decision must commit even if PostHog is down).
//
// Services depend on THIS, not on a sink or PostHog. `createNoopAnalytics()` is
// the default so a service constructed without analytics config still works and
// still exercises the same code path.

import {
  EVENTS, SURFACE, ROLE, assertNoPii, hoursBetween,
  classifyTransition, planHeadline, planPercentComplete,
} from './events.mjs';
import { createNoopSink } from './sink.mjs';

/**
 * @param {object} deps
 * @param {object} deps.sink       a sink from ./sink.mjs (memory | posthog | noop)
 * @param {string} [deps.releaseSha]  build sha stamped on every event (§2.4)
 * @param {(err:Error, ctx:object)=>void} [deps.onError]  observe swallowed errors
 */
export function createAnalytics({ sink, releaseSha = null, onError = () => {} } = {}) {
  if (!sink) throw new Error('createAnalytics requires a sink');

  // Super-properties sent on EVERY event (§2.2). project/actor identity + build.
  function superProps({ projectId, actorPartyId, actorRole, surface }) {
    return {
      project_id: projectId,
      actor_party_id: actorPartyId,
      actor_role: actorRole ?? null,
      release_sha: releaseSha,
      surface,
    };
  }

  // The one guarded dispatch path. Every emit funnels through here so the PII
  // guard and the try/catch are impossible to bypass.
  function emit(event, { projectId, actorPartyId, actorRole, surface, props }) {
    try {
      const properties = assertNoPii(
        { ...superProps({ projectId, actorPartyId, actorRole, surface }), ...props },
        event,
      );
      sink.capture({
        event,
        distinctId: actorPartyId, // §2.1 distinct_id == party_id (server-authenticated)
        properties,
        groups: { project: projectId }, // §2.1 group('project', project_id)
      });
    } catch (err) {
      onError(err, { event, projectId });
    }
  }

  // ── Identity model (§2.1) ──────────────────────────────────────────────────
  function identifyParty({ partyId, role, firstSeenAt }) {
    try {
      // display_name is deliberately omitted (PII, §2.1/§3) — analysis needs role
      // + stable id only.
      sink.identify({
        distinctId: partyId,
        properties: assertNoPii({ role, first_seen_at: firstSeenAt }, '$identify'),
      });
    } catch (err) {
      onError(err, { event: '$identify', partyId });
    }
  }

  function identifyProject({ projectId, baselineBudgetCents, createdAt, hasCounterparty, coCount }) {
    try {
      const properties = {};
      if (baselineBudgetCents != null) properties.baseline_budget_cents = baselineBudgetCents;
      if (createdAt != null) properties.created_at = createdAt;
      if (hasCounterparty != null) properties.has_counterparty = hasCounterparty;
      if (coCount != null) properties.co_count = coCount;
      sink.groupIdentify({ groupType: 'project', groupKey: projectId, properties: assertNoPii(properties, '$groupidentify') });
    } catch (err) {
      onError(err, { event: '$groupidentify', projectId });
    }
  }

  // ── Group-A domain-write events (§2.3) ─────────────────────────────────────

  function projectCreated({ projectId, actorPartyId, baselineBudgetCents, createdAt }) {
    // Owner identity + project group established on genesis.
    identifyParty({ partyId: actorPartyId, role: ROLE.OWNER, firstSeenAt: createdAt });
    identifyProject({ projectId, baselineBudgetCents, createdAt, hasCounterparty: false, coCount: 0 });
    emit(EVENTS.PROJECT_CREATED, {
      projectId, actorPartyId, actorRole: ROLE.OWNER, surface: SURFACE.HOME,
      props: { baseline_budget_cents: baselineBudgetCents, has_baseline: baselineBudgetCents > 0 },
    });
  }

  function gcInvited({ projectId, actorPartyId, actorRole }) {
    emit(EVENTS.GC_INVITED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.HOME,
      props: { invite_method: 'link' }, // R0 invites are single-use links (§2.3)
    });
  }

  function gcJoined({ projectId, actorPartyId, projectCreatedAt, joinedAt }) {
    identifyParty({ partyId: actorPartyId, role: ROLE.COUNTERPARTY, firstSeenAt: joinedAt });
    identifyProject({ projectId, hasCounterparty: true });
    emit(EVENTS.GC_JOINED, {
      projectId, actorPartyId, actorRole: ROLE.COUNTERPARTY, surface: SURFACE.HOME,
      props: { hours_since_created: hoursBetween(projectCreatedAt, joinedAt) },
    });
  }

  function decisionLogged({ projectId, actorPartyId, actorRole, decisionId, body }) {
    const text = typeof body === 'string' ? body : '';
    emit(EVENTS.DECISION_LOGGED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.DECISIONS,
      props: { decision_id: decisionId, has_body: text.length > 0, body_len: text.length },
    });
  }

  function decisionAmended({ projectId, actorPartyId, actorRole, decisionId, rev }) {
    emit(EVENTS.DECISION_AMENDED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.DECISIONS,
      props: { decision_id: decisionId, rev },
    });
  }

  function changeOrderRaised({
    projectId, actorPartyId, actorRole, changeOrderId, costDeltaCents,
    linkedToDecision, scheduleImpactDays, hasScopeNote, qualityFlag,
  }) {
    emit(EVENTS.CHANGE_ORDER_RAISED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.CHANGES,
      props: {
        change_order_id: changeOrderId,
        cost_delta_cents: costDeltaCents,
        linked_to_decision: !!linkedToDecision,
        schedule_impact_days: scheduleImpactDays ?? null,
        has_scope_note: !!hasScopeNote,
        quality_flag: !!qualityFlag,
      },
    });
  }

  function changeOrderDecided({
    projectId, actorPartyId, decidedByRole, changeOrderId, decision,
    costDeltaCents, isSelfApproval, raisedAt, decidedAt,
  }) {
    emit(EVENTS.CHANGE_ORDER_DECIDED, {
      projectId, actorPartyId, actorRole: decidedByRole, surface: SURFACE.CHANGES,
      props: {
        change_order_id: changeOrderId,
        decision, // 'approved' | 'rejected'
        cost_delta_cents: costDeltaCents,
        // §2.4: MUST be sent (not assumed) so a regression of the server self-
        // approval gate is detectable in the data. In a correct system it is
        // always false because the gate blocks self-decision before we reach here.
        is_self_approval: !!isSelfApproval,
        hours_since_raised: hoursBetween(raisedAt, decidedAt),
        decided_by_role: decidedByRole ?? null,
      },
    });
  }

  function budgetEventWritten({ projectId, actorPartyId, actorRole, changeOrderId, deltaCents, newCurrentCents }) {
    emit(EVENTS.BUDGET_EVENT_WRITTEN, {
      projectId, actorPartyId, actorRole, surface: SURFACE.BUDGET,
      props: { change_order_id: changeOrderId, delta_cents: deltaCents, new_current_cents: newCurrentCents },
    });
  }

  // ── Group-C plan/progress events (Slice 6, LINA-71) ────────────────────────
  //
  // Rollup context (`plan_*`, `*_stage_count`) rides along on plan events as a
  // MEASUREMENT SNAPSHOT — it is not a stored rollup and PostHog is not its
  // source of truth (spec §8.3 R4: recomputed on read, never cached as truth).
  // It is carried so a headline can be charted over time and so `entered_blocked`
  // can be correlated with a later change order without a join back to the DB.
  //
  // `rollup` is the plan state AFTER the write, counted per §8.3: equal
  // weighting, `done` only, advisory percent excluded.
  function rollupProps(rollup) {
    if (!rollup) return {};
    const { stageCount = 0, doneStageCount = 0, blockedStageCount = 0, inProgressStageCount = 0 } = rollup;
    return {
      stage_count: stageCount,
      done_stage_count: doneStageCount,
      blocked_stage_count: blockedStageCount,
      in_progress_stage_count: inProgressStageCount,
      plan_headline: planHeadline({ stageCount, doneStageCount, blockedStageCount, inProgressStageCount }),
      plan_percent_complete: planPercentComplete(doneStageCount, stageCount),
    };
  }

  function planDocumentUploaded({
    projectId, actorPartyId, actorRole, planDocumentId, revision,
    supersededDocumentId = null, contentHash = null, byteSize = null,
    mimeType = null, gcJoinedAt = null, uploadedAt = null, rollup = null,
  }) {
    emit(EVENTS.PLAN_DOCUMENT_UPLOADED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.PLAN,
      props: {
        plan_document_id: planDocumentId,
        revision,                                  // 1-based; 1 == first upload
        is_replacement: revision > 1,              // §6: first upload vs replacement
        superseded_document_id: supersededDocumentId,
        // 32-char sha256 PREFIX: enough to correlate with AC-P2's content-hash
        // proof, and stays clear of the 64-char free-text guard.
        content_hash: contentHash ? String(contentHash).slice(0, 32) : null,
        byte_size: byteSize,
        mime_type: mimeType,                       // filename is PII — never sent
        hours_since_gc_joined: gcJoinedAt && uploadedAt ? hoursBetween(gcJoinedAt, uploadedAt) : null,
        ...rollupProps(rollup),
      },
    });
  }

  function stageAdded({
    projectId, actorPartyId, actorRole, stageId, position,
    plannedCostCents = null, plannedDurationDays = null, hasPlannedDates = false,
    isFirstStage = false, gcJoinedAt = null, addedAt = null, rollup = null,
  }) {
    emit(EVENTS.STAGE_ADDED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.PLAN,
      props: {
        stage_id: stageId,
        position,                                   // 1-based plan order
        is_first_stage: isFirstStage,
        // Time-to-first-stage (§6): meaningful when is_first_stage is true.
        hours_since_gc_joined: gcJoinedAt && addedAt ? hoursBetween(gcJoinedAt, addedAt) : null,
        has_planned_cost: plannedCostCents != null,
        // Planned cost is reported for plan-completeness only. It is NEVER a
        // budget number (spec §2 Q2 / AC-P5) — no budget metric may read it.
        planned_cost_cents: plannedCostCents,
        has_planned_dates: !!hasPlannedDates,
        planned_duration_days: plannedDurationDays,
        ...rollupProps(rollup),
      },
    });
  }

  function stageUpdated({
    projectId, actorPartyId, actorRole, stageId, updateKind,
    positionFrom = null, positionTo = null, fieldsChangedCount = 0,
    labelChanged = false, noteChanged = false, costChanged = false, datesChanged = false,
    plannedCostDeltaCents = null, rollup = null,
  }) {
    emit(EVENTS.STAGE_UPDATED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.PLAN,
      props: {
        stage_id: stageId,
        update_kind: updateKind,                    // STAGE_UPDATE_KIND enum
        position_from: positionFrom,
        position_to: positionTo,
        fields_changed_count: fieldsChangedCount,
        // `has_*` prefix is required, not stylistic: the PII guard rejects any
        // key containing "name"/"note"/"title" unless it is a has_/_len/_count.
        has_label_change: !!labelChanged,
        has_note_change: !!noteChanged,
        has_cost_change: !!costChanged,
        has_date_change: !!datesChanged,
        planned_cost_delta_cents: plannedCostDeltaCents,
        ...rollupProps(rollup),
      },
    });
  }

  function progressReported({
    projectId, actorPartyId, actorRole, stageId, entrySeq,
    statusFrom, statusTo, advisoryPercent = null, note = null,
    previousEntryAt = null, reportedAt = null,
    isFirstProgressForStage = false, isFirstProgressForProject = false,
    gcJoinedAt = null, rollup = null,
  }) {
    const text = typeof note === 'string' ? note : '';
    emit(EVENTS.PROGRESS_REPORTED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.PLAN,
      props: {
        stage_id: stageId,
        // Ledger seq — the §8.1 tiebreaker. Carried so the analytics ordering
        // matches the ordering the homeowner's headline was derived from (AC-P9).
        entry_seq: entrySeq,
        status_from: statusFrom,
        status_to: statusTo,
        ...classifyTransition(statusFrom, statusTo),
        // Dwell time in the status being left. On an `exited_blocked` event this
        // IS "how long did the stage stay blocked".
        hours_in_previous_status:
          previousEntryAt && reportedAt ? hoursBetween(previousEntryAt, reportedAt) : null,
        // ADVISORY ONLY (spec §2 Q1). Carried for texture; must never carry a
        // funnel, a rollup, or a target. Status is the source of truth.
        advisory_percent: advisoryPercent,
        has_note: text.length > 0,
        note_len: text.length,
        is_first_progress_for_stage: !!isFirstProgressForStage,
        is_first_progress_for_project: !!isFirstProgressForProject,
        // Time-to-first-progress (§6): meaningful when
        // is_first_progress_for_project is true.
        hours_since_gc_joined: gcJoinedAt && reportedAt ? hoursBetween(gcJoinedAt, reportedAt) : null,
        ...rollupProps(rollup),
      },
    });
  }

  // The activation metric for the whole forward-looking half of R0 (§6.4).
  // Server-side only: emitted from the plan-timeline READ handler, never the
  // browser — the issue forbids a second emission path. Emit once per primary
  // timeline read (not per sub-resource fetch); uniqueness is resolved in
  // analysis, not at emission.
  function planTimelineViewed({
    projectId, actorPartyId, actorRole, hasPlanDocument = false,
    gcJoinedAt = null, firstStageAt = null, viewedAt = null, rollup = null,
  }) {
    emit(EVENTS.PLAN_TIMELINE_VIEWED, {
      projectId, actorPartyId, actorRole, surface: SURFACE.PLAN,
      props: {
        // Homeowner activation == this event filtered to actor_role == 'owner'.
        has_plan_document: !!hasPlanDocument,
        // True when the GC has not filled the plan in yet — the §5 empty state.
        // Kept explicit so empty-state views can never inflate activation.
        is_empty_plan: !(rollup?.stageCount > 0),
        hours_since_gc_joined: gcJoinedAt && viewedAt ? hoursBetween(gcJoinedAt, viewedAt) : null,
        hours_since_first_stage: firstStageAt && viewedAt ? hoursBetween(firstStageAt, viewedAt) : null,
        ...rollupProps(rollup),
      },
    });
  }

  async function flush() { try { await sink.flush?.(); } catch (err) { onError(err, { event: 'flush' }); } }

  return {
    identifyParty, identifyProject,
    projectCreated, gcInvited, gcJoined,
    decisionLogged, decisionAmended,
    changeOrderRaised, changeOrderDecided, budgetEventWritten,
    planDocumentUploaded, stageAdded, stageUpdated, progressReported, planTimelineViewed,
    flush,
  };
}

// Default no-op analytics: same surface, drops everything. Lets every service
// take `analytics` as a real (never-undefined) dependency.
export function createNoopAnalytics() {
  return createAnalytics({ sink: createNoopSink() });
}
