// /settings data layer on `/api/v2` (PRD-12 N-8..N-10). I/O only — the pure
// arranging is `./settings-view.ts`. Reads fail closed to null/[] (a viewer
// without the permission sees an honest "not yours to manage", never a crash);
// writes rethrow the V2Error so the action can show the server's reason.
import 'server-only';
import { randomUUID } from 'node:crypto';

import { v2, V2Error } from './client';
import type {
  OrgRole, V2Member, V2MeSettings, V2Plan, V2Subscription, V2Usage,
} from './settings-view';

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

// ── personal (N-8) ───────────────────────────────────────────────────────────

export function getMeSettings(): Promise<V2MeSettings | null> {
  return orNull(v2<V2MeSettings>({ method: 'GET', path: '/me' }));
}

export async function updateMyProfile(input: { name: string; locale: string }): Promise<void> {
  await v2({ method: 'PUT', path: '/me/profile', body: input });
}

// ── organisation (N-9) ───────────────────────────────────────────────────────

export async function listOrgMembers(orgId: string): Promise<V2Member[] | null> {
  const page = await orNull(v2<{ items: V2Member[] }>({
    method: 'GET', path: `/organizations/${encodeURIComponent(orgId)}/members`, query: { limit: 200 },
  }));
  return page?.items ?? null;
}

export async function inviteMember(orgId: string, input: { email: string; org_role: OrgRole }): Promise<void> {
  await v2({
    method: 'POST',
    path: `/organizations/${encodeURIComponent(orgId)}/invitations`,
    body: input,
    idempotencyKey: randomUUID(),
  });
}

export async function updateMemberRole(orgId: string, personId: string, role: OrgRole): Promise<void> {
  await v2({
    method: 'PATCH',
    path: `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(personId)}`,
    body: { org_role: role },
  });
}

export async function removeMember(orgId: string, personId: string): Promise<void> {
  await v2({
    method: 'DELETE',
    path: `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(personId)}`,
  });
}

// ── billing (N-10) ───────────────────────────────────────────────────────────

export function getMySubscription(): Promise<V2Subscription | null> {
  return orNull(v2<V2Subscription>({ method: 'GET', path: '/billing/subscription' }));
}

export async function listPlans(): Promise<V2Plan[]> {
  const page = await orNull(v2<{ items: V2Plan[] }>({ method: 'GET', path: '/billing/plans', query: { limit: 50 } }));
  return page?.items ?? [];
}

export function getUsage(): Promise<V2Usage | null> {
  return orNull(v2<V2Usage>({ method: 'GET', path: '/billing/usage' }));
}

export async function subscribe(planCode: string): Promise<void> {
  await v2({ method: 'POST', path: '/billing/subscriptions', body: { plan_code: planCode }, idempotencyKey: randomUUID() });
}

export async function changeSubscription(subscriptionId: string, planCode: string): Promise<void> {
  await v2({
    method: 'PATCH', path: `/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, body: { plan_code: planCode },
  });
}

export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await v2({
    method: 'POST',
    path: `/billing/subscriptions/${encodeURIComponent(subscriptionId)}:cancel`,
    idempotencyKey: randomUUID(),
  });
}
