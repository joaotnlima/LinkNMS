// /settings/billing — plan, entitlements, change and cancel (PRD-12 N-10, D-05).
// Every figure is what the billing API answers (catalogue prices, usage vs
// limits); nothing is priced here (AGENT-INDEX: pricing numbers out of scope).
// Needs `org:billing:manage`. No charging provider is connected yet (open
// question 17), so there are no invoices to list — the page says so.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type { PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import { getMeSettings, getMySubscription, getUsage, listPlans } from '@/lib/v2/settings';
import {
  SUBSCRIPTION_STATUS_LABEL, can, entitlementRows, planPriceLabel, subscriptionActions,
} from '@/lib/v2/settings-view';
import { sessionState } from '@/server/session';

import { cancelSubscriptionAction, changePlanAction, subscribeAction } from '../actions';
import { SettingsFrame } from '../SettingsFrame';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Billing · LinkNMS' };

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/settings/billing');
  if (state.kind === 'unseated') redirect('/no-access');

  const [{ saved, error }, profile, me] = await Promise.all([searchParams, getViewerProfile(), getMeSettings()]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const allowed = Boolean(me?.active_org) && can(me, 'org:billing:manage');
  const [sub, plans, usage] = allowed
    ? await Promise.all([getMySubscription(), listPlans(), getUsage()])
    : [null, [], null];
  const actions = subscriptionActions(sub);
  const rows = entitlementRows(usage);
  const plan = sub?.plan ?? null;
  const others = plans.filter((p) => p.code !== sub?.plan_code);

  return (
    <SettingsFrame user={user} tab="billing" saved={saved} error={error}>
      {!allowed ? (
        <section className="set-card"><h2>Billing</h2>
          <p>Only an admin or the finance role of your organisation manages its subscription.</p>
        </section>
      ) : (
        <>
          <section className="set-card" aria-labelledby="set-plan">
            <h2 id="set-plan">Plan</h2>
            {sub ? (
              <dl className="set-kv">
                <dt>Plan</dt><dd>{plan?.name ?? sub.plan_code}</dd>
                {plan ? (<><dt>Price</dt><dd>{planPriceLabel(plan)}</dd></>) : null}
                <dt>Status</dt><dd>{SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status}</dd>
                {sub.current_period_end ? (<><dt>Renews</dt>
                  <dd>{new Date(sub.current_period_end).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Europe/Lisbon' })}</dd></>) : null}
              </dl>
            ) : <p>Your organisation has no subscription yet.</p>}

            {actions.canChange && others.length ? (
              <form action={changePlanAction} className="set-inline">
                <input type="hidden" name="subscription_id" value={sub!.id} />
                <select name="plan_code" aria-label="New plan">
                  {others.map((p) => <option key={p.code} value={p.code}>{p.name} — {planPriceLabel(p)}</option>)}
                </select>
                <button type="submit" className="set-btn is-quiet">Change plan</button>
              </form>
            ) : null}
            {actions.canSubscribe && plans.length ? (
              <form action={subscribeAction} className="set-inline">
                <select name="plan_code" aria-label="Plan">
                  {plans.map((p) => <option key={p.code} value={p.code}>{p.name} — {planPriceLabel(p)}</option>)}
                </select>
                <button type="submit" className="set-btn">Subscribe</button>
              </form>
            ) : null}
          </section>

          <section className="set-card" aria-labelledby="set-ent">
            <h2 id="set-ent">What your plan covers</h2>
            {rows.length ? (
              <table className="set-table">
                <thead><tr><th>Capability</th><th>Used</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className={`set-meter${r.full ? ' is-full' : ''}`}>{r.used} of {r.limit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p>Nothing is metered without a live subscription. Reading your builds and their record is never blocked.</p>}
          </section>

          <section className="set-card" aria-labelledby="set-inv">
            <h2 id="set-inv">Invoices</h2>
            <p>Invoices appear here once a billing provider is connected. None has been issued.</p>
          </section>

          {sub && actions.canCancel ? (
            <section className="set-card" aria-labelledby="set-cancel">
              <h2 id="set-cancel">Cancel subscription</h2>
              <p>Creating builds, tenders and seats stops; everything already agreed stays readable.</p>
              <form action={cancelSubscriptionAction}>
                <input type="hidden" name="subscription_id" value={sub.id} />
                <button type="submit" className="set-btn is-danger">Cancel subscription</button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </SettingsFrame>
  );
}
