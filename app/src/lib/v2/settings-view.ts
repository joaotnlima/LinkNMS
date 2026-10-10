// Pure v2-wire → view transforms for /settings (PRD-12 N-8..N-10). The I/O is in
// `./settings.ts`. Nothing here decides access: which roles an org may hand out
// comes from `Me.assignable_roles`, who may manage members or billing from the
// permissions the server resolved, and every price from the billing API as-is.
import type { V2Money, V2OrgKind } from './profile-view.ts';
import { formatCents } from '../format.ts';

export type OrgRole = 'admin' | 'manager' | 'representative' | 'site_lead' | 'finance' | 'member' | 'inspector';

export interface V2MeSettings {
  person: { id: string; email: string; name: string; locale: 'pt-PT' | 'en' | 'es' };
  active_org: { id: string; kind: V2OrgKind; legal_name: string } | null;
  org_role: string | null;
  permissions: string[];
  assignable_roles?: OrgRole[];
}

export interface V2Member {
  id: string;
  email: string;
  name: string;
  locale: string;
  org_role: OrgRole;
}

export interface V2Plan {
  code: string;
  org_kind: string;
  name: string;
  price: V2Money;
  interval: 'month' | 'year' | 'project';
  entitlements: Record<string, number>;
}

export interface V2Subscription {
  id: string;
  org_id: string;
  plan_code: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  current_period_end: string | null;
  plan?: V2Plan | null;
}

export interface V2Usage {
  entitlements: Record<string, { limit: number; used: number }>;
}

export const LOCALES: { value: 'pt-PT' | 'en' | 'es'; label: string }[] = [
  { value: 'pt-PT', label: 'Português (Portugal)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

export const ROLE_LABEL: Record<OrgRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  representative: 'Client representative',
  site_lead: 'Site lead',
  finance: 'Finance',
  member: 'Member',
  inspector: 'Inspector',
};

export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABEL as Record<string, string>)[role] ?? role : '';
}

export const ORG_KIND_LABEL: Record<V2OrgKind, string> = {
  household: 'Household',
  contractor: 'Contractor',
  consultant: 'Consultant',
  supplier: 'Supplier',
};

export function can(me: Pick<V2MeSettings, 'permissions'> | null, permission: string): boolean {
  return Boolean(me?.permissions?.includes(permission));
}

const ENTITLEMENT_LABEL: Record<string, string> = {
  'projects:active': 'Active builds',
  seats: 'Seats (members)',
  'rfp:open-credits': 'Open tenders this month',
};

export interface EntitlementRow { key: string; label: string; used: number; limit: number; full: boolean }

/** Usage rows in a stable order; unknown keys keep their raw name. */
export function entitlementRows(usage: V2Usage | null): EntitlementRow[] {
  if (!usage) return [];
  return Object.entries(usage.entitlements)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      key, label: ENTITLEMENT_LABEL[key] ?? key, used: v.used, limit: v.limit, full: v.used >= v.limit,
    }));
}

const INTERVAL_LABEL: Record<V2Plan['interval'], string> = { month: 'per month', year: 'per year', project: 'per build' };

/** "€49.00 per month" — the API's own Money, formatted, never computed. */
export function planPriceLabel(plan: Pick<V2Plan, 'price' | 'interval'>): string {
  return `${formatCents(plan.price.amount_cents, { currency: plan.price.currency, fractionDigits: 2 })} ${INTERVAL_LABEL[plan.interval] ?? ''}`.trim();
}

export const SUBSCRIPTION_STATUS_LABEL: Record<V2Subscription['status'], string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  canceled: 'Canceled',
};

/** Live subscriptions can change plan or be canceled (billing domain LIVE_STATUSES). */
export function subscriptionActions(sub: V2Subscription | null): { canChange: boolean; canCancel: boolean; canSubscribe: boolean } {
  if (!sub) return { canChange: false, canCancel: false, canSubscribe: true };
  const live = sub.status === 'trialing' || sub.status === 'active';
  return { canChange: live, canCancel: sub.status !== 'canceled', canSubscribe: sub.status === 'canceled' };
}
