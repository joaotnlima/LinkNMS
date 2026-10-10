'use server';

// /settings writes (PRD-12 N-8..N-10). Each action calls ONE v2 operation and
// lands back on its page with `?saved=` or `?error=` — the server's reason is
// shown as-is (role refused, last admin, no free seat, …); nothing is decided
// here. The v2 client is server-only, hence server actions.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { V2Error } from '@/lib/v2/client';
import { putNotificationPreferences } from '@/lib/v2/notifications';
import { preferencesFromForm } from '@/lib/v2/notifications-view';
import {
  cancelSubscription, changeSubscription, inviteMember, removeMember, subscribe,
  updateMemberRole, updateMyProfile,
} from '@/lib/v2/settings';
import type { OrgRole } from '@/lib/v2/settings-view';

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

async function run(path: string, saved: string, fn: () => Promise<void>): Promise<never> {
  let target = `${path}?saved=${saved}`;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    const reason = err.errors ? Object.values(err.errors).join('; ') : err.message;
    target = `${path}?error=${encodeURIComponent(reason)}`;
  }
  revalidatePath(path);
  redirect(target);
}

// ── personal ─────────────────────────────────────────────────────────────────

export async function saveProfileAction(fd: FormData): Promise<void> {
  await run('/settings', 'profile', () => updateMyProfile({ name: str(fd, 'name'), locale: str(fd, 'locale') }));
}

export async function savePreferencesAction(fd: FormData): Promise<void> {
  const categories = str(fd, 'categories').split(',').filter(Boolean);
  const items = preferencesFromForm(categories, (name) => fd.get(name) === 'on');
  await run('/settings', 'notifications', async () => { await putNotificationPreferences(items); });
}

// ── organisation ─────────────────────────────────────────────────────────────

export async function inviteMemberAction(fd: FormData): Promise<void> {
  await run('/settings/organization', 'invited', () =>
    inviteMember(str(fd, 'org_id'), { email: str(fd, 'email'), org_role: str(fd, 'org_role') as OrgRole }));
}

export async function changeRoleAction(fd: FormData): Promise<void> {
  await run('/settings/organization', 'role', () =>
    updateMemberRole(str(fd, 'org_id'), str(fd, 'person_id'), str(fd, 'org_role') as OrgRole));
}

export async function removeMemberAction(fd: FormData): Promise<void> {
  await run('/settings/organization', 'removed', () => removeMember(str(fd, 'org_id'), str(fd, 'person_id')));
}

// ── billing ──────────────────────────────────────────────────────────────────

export async function subscribeAction(fd: FormData): Promise<void> {
  await run('/settings/billing', 'subscribed', () => subscribe(str(fd, 'plan_code')));
}

export async function changePlanAction(fd: FormData): Promise<void> {
  await run('/settings/billing', 'plan', () => changeSubscription(str(fd, 'subscription_id'), str(fd, 'plan_code')));
}

export async function cancelSubscriptionAction(fd: FormData): Promise<void> {
  await run('/settings/billing', 'canceled', () => cancelSubscription(str(fd, 'subscription_id')));
}
