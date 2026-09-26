// Billing module use cases (phase 8) — one function per operationId:
//   listPlans, subscribe, changeSubscription, cancelSubscription, getUsage,
//   buyAddOn, billingWebhook.
//
// Authorization (contract + doc 16): listPlans needs only a session with an
// active org (the catalogue is filtered by viewer.orgKind); every command and
// getUsage need `org:billing:manage` (403 reason 'role' without it).
// subscribe and changeSubscription are x-human-only: the MCP channel is
// answered forbidden{reason:'human_only'} before anything else (doc 19).
//
// NO charging provider is wired — open question 17 (Clerk Billing vs Stripe +
// AT-certified invoicing is a founder decision). Subscriptions are created in
// "manual" mode: provider_ref = null, nothing is charged, and billingWebhook
// answers 404 for every provider name. The port boundary (store + these use
// cases + application/entitled.mjs) is where a provider adapter lands later
// without contract change.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import {
  ADD_ON_KEY, ADD_ON_KINDS, BLOCKING_STATUSES, LIVE_STATUSES,
  planBody, subscriptionBody,
} from '../domain/model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** operationId: listPlans — the catalogue for the viewer's org kind. */
export async function listPlans({ viewer, store, query }) {
  requireActiveOrg(viewer);
  const { items, nextCursor } = await store.listPlans({
    orgKind: viewer.orgKind,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(planBody), next_cursor: nextCursor } };
}

/** operationId: subscribe — human-only; one subscription per org. */
export async function subscribe({ viewer, store, body, idempotencyKey }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'subscribing');
  requireBillingManage(viewer);

  const plan = await requirePlanForOrgKind({ store, viewer, planCode: body?.plan_code });

  // One subscription per org (doc 15: org_id UNIQUE). A live-or-past_due one
  // refuses; only a canceled slot may be replaced (the store re-checks under
  // lock, so a race cannot mint a second live subscription).
  const existing = await store.getSubscriptionByOrg(viewer.orgId);
  if (existing && BLOCKING_STATUSES.includes(existing.status)) {
    throw new ProblemError('invalid_transition', 'this organisation already has a subscription — change or cancel it instead');
  }

  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'subscribe', body }, async () => {
    const row = await store.subscribe({
      id: randomUUID(),
      orgId: viewer.orgId,
      planCode: plan.code,
      interval: plan.interval,
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: subscriptionBody(row) };
  });
}

/** operationId: changeSubscription — human-only; only plan_code may change. */
export async function changeSubscription({ viewer, store, subscriptionId, body }) {
  requireActiveOrg(viewer);
  requireHuman(viewer, 'changing a subscription');
  requireBillingManage(viewer);

  const sub = await requireOwnSubscription({ store, viewer, subscriptionId });
  const plan = await requirePlanForOrgKind({ store, viewer, planCode: body?.plan_code });
  if (!LIVE_STATUSES.includes(sub.status)) {
    throw new ProblemError('invalid_transition', `a ${sub.status} subscription cannot change plan — subscribe again`);
  }
  if (plan.code === sub.plan_code) return { status: 200, body: subscriptionBody(sub) };

  // PATCH semantics: plan_code is the ONLY writable field. status has its own
  // command (cancel), the period end belongs to the (absent) provider, and
  // id/org_id are identity — other Subscription fields in the body are ignored.
  const actor = await requireActor(store, viewer);
  const row = await store.changePlan({ subscriptionId: sub.id, planCode: plan.code, actor: actorOf(actor, viewer) });
  return { status: 200, body: subscriptionBody(row) };
}

/** operationId: cancelSubscription — idempotent; canceling a canceled sub is a 200 replay. */
export async function cancelSubscription({ viewer, store, subscriptionId }) {
  requireActiveOrg(viewer);
  requireBillingManage(viewer);

  const sub = await requireOwnSubscription({ store, viewer, subscriptionId });
  if (sub.status === 'canceled') return { status: 200, body: subscriptionBody(sub) };

  const actor = await requireActor(store, viewer);
  const row = await store.cancel({ subscriptionId: sub.id, actor: actorOf(actor, viewer) });
  return { status: 200, body: subscriptionBody(row) };
}

/** operationId: getUsage — used vs limit for every key the org's plan meters. */
export async function getUsage({ viewer, store }) {
  requireActiveOrg(viewer);
  requireBillingManage(viewer);

  const sub = await store.getSubscriptionByOrg(viewer.orgId);
  if (!sub) return { status: 200, body: { entitlements: {} } };

  const plan = await store.getPlan(sub.plan_code);
  const usage = await store.usage(viewer.orgId);
  const entitlements = {};
  for (const [key, base] of Object.entries(plan?.entitlements ?? {})) {
    const addOnKind = Object.entries(ADD_ON_KEY).find(([, k]) => k === key)?.[0] ?? null;
    const extra = addOnKind ? await store.addOnQuantity(viewer.orgId, addOnKind) : 0;
    entitlements[key] = { limit: Number(base) + extra, used: usage[key] ?? 0 };
  }
  return { status: 200, body: { entitlements } };
}

/** operationId: buyAddOn — open-RFP credits / promotion on a live subscription. */
export async function buyAddOn({ viewer, store, body, idempotencyKey }) {
  requireActiveOrg(viewer);
  requireBillingManage(viewer);

  // The contract's request body is the Plan schema: `code` names WHAT is
  // bought — an add-on kind — and `entitlements.quantity` how much.
  const kind = body?.code;
  if (!ADD_ON_KINDS.includes(kind)) {
    throw new ProblemError('validation_failed', null, { errors: { code: `one of ${ADD_ON_KINDS.join(', ')}` } });
  }
  // Default 1: one credit / one promotion slot — an add-on without a quantity
  // is a single purchase, and the DB CHECK-free int column stays honest.
  const quantity = body?.entitlements?.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new ProblemError('validation_failed', null, { errors: { 'entitlements.quantity': 'an integer between 1 and 1000' } });
  }

  const sub = await store.getSubscriptionByOrg(viewer.orgId);
  if (!sub || !LIVE_STATUSES.includes(sub.status)) {
    throw new ProblemError('not_entitled', 'add-ons top up a live subscription — subscribe first',
      { upgrade_hint: 'POST /billing/subscriptions' });
  }

  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'buyAddOn', body }, async () => {
    await store.addAddOn({
      id: randomUUID(),
      orgId: viewer.orgId,
      kind,
      quantity,
      actor: actorOf(actor, viewer),
    });
    // The contract answers buyAddOn with the org's Subscription.
    return { status: 201, body: subscriptionBody(sub) };
  });
}

/**
 * operationId: billingWebhook — 404 for EVERY provider name, verifying
 * nothing and accepting nothing: no charging provider is registered while
 * open question 17 (14-open-questions.md — Clerk Billing vs Stripe +
 * AT-certified invoicing) awaits the founder. When a provider is chosen, its
 * adapter registers here (signature check over rawBody, then store calls) —
 * a wiring change behind this same route, no contract change.
 */
export async function billingWebhook({ params }) {
  throw new ProblemError('not_found', `no billing provider "${params.provider}" is registered`);
}

// ── shared helpers ───────────────────────────────────────────────────────

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function requireBillingManage(viewer) {
  if (!viewer.has('org:billing:manage')) throw new ProblemError('forbidden', null, { reason: 'role' });
}

/** x-human-only (doc 19): never reachable through MCP. */
function requireHuman(viewer, what) {
  if (viewer.channel === 'mcp') {
    throw new ProblemError('forbidden', `${what} is human-only`, { reason: 'human_only' });
  }
}

/** The plan must exist AND be sold to the viewer's org kind (422 otherwise). */
async function requirePlanForOrgKind({ store, viewer, planCode }) {
  const errors = {};
  if (typeof planCode !== 'string' || !planCode.trim()) {
    errors.plan_code = 'required';
    throw new ProblemError('validation_failed', null, { errors });
  }
  const plan = await store.getPlan(planCode);
  if (!plan || plan.org_kind !== viewer.orgKind) {
    // One answer for "no such plan" and "not your kind": the catalogue an org
    // sees is already filtered by kind, so both are "not a plan you can buy".
    throw new ProblemError('validation_failed', null, { errors: { plan_code: `not a plan for a ${viewer.orgKind ?? 'personal'} organisation` } });
  }
  return plan;
}

/** Existence hiding: another org's subscription id answers 404, never 403. */
async function requireOwnSubscription({ store, viewer, subscriptionId }) {
  if (!UUID.test(subscriptionId ?? '')) throw new ProblemError('not_found');
  const sub = await store.getSubscription(subscriptionId);
  if (!sub || sub.org_id !== viewer.orgId) throw new ProblemError('not_found');
  return sub;
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}
