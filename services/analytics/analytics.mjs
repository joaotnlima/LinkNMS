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

import { EVENTS, SURFACE, ROLE, assertNoPii, hoursBetween } from './events.mjs';
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

  async function flush() { try { await sink.flush?.(); } catch (err) { onError(err, { event: 'flush' }); } }

  return {
    identifyParty, identifyProject,
    projectCreated, gcInvited, gcJoined,
    decisionLogged, decisionAmended,
    changeOrderRaised, changeOrderDecided, budgetEventWritten,
    flush,
  };
}

// Default no-op analytics: same surface, drops everything. Lets every service
// take `analytics` as a real (never-undefined) dependency.
export function createNoopAnalytics() {
  return createAnalytics({ sink: createNoopSink() });
}
