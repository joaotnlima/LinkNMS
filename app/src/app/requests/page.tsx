// /requests — the company inbox (PRD-04 X-9, X-10; D-47). Two tabs:
//   Requests for you      — every invite the company holds: where it came from
//                           (found in the directory / invited by email / asked
//                           to bid), who asks, bids due, tasks and files, with
//                           Open and price / Decline;
//   Open requests near you — listed RFPs matching the company's specialties and
//                           service area (the server matches, through the
//                           directory's profile), with Ask to bid.
// It replaces /marketplace (X-12). Every rule is the server's; this page lays
// out what it answered.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { listOpenRequests, listRequestsForMe } from '@/lib/v2/company-inbox';
import { getViewerProfile } from '@/lib/v2/profile';
import {
  inboxTab, openRequestAction, openRequestLine, originLine, requestState,
} from '@/lib/v2/rfp-directory-view';
import { sessionState } from '@/server/session';

import { askToBidAction, declineInvitationAction } from './actions';
import './requests.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Requests · LinkNMS' };

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; done?: string; error?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/requests');
  if (state.kind === 'unseated') redirect('/no-access');
  if (!state.session.setupComplete) redirect('/onboarding/setup');

  const sp = await searchParams;
  const tab = inboxTab(sp.tab);
  const [profile, forYou, near] = await Promise.all([getViewerProfile(), listRequestsForMe(), listOpenRequests()]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const fresh = forYou.filter((r) => requestState(r).label === 'New').length;

  return (
    <PortalShell user={user} switcherLabel="Requests" align="start">
      <div className="mkt">
        <header className="mkt-head">
          <h1>Requests</h1>
          <p className="mkt-sub">Tenders you are invited to, and open requests near you that you can ask to bid on.</p>
        </header>
        <nav className="inbox-tabs" aria-label="Requests">
          <Link href="/requests?tab=for-you" aria-current={tab === 'for-you' ? 'page' : undefined}>
            Requests for you{fresh ? <span className="badge count">{fresh} new</span> : null}
          </Link>
          <Link href="/requests?tab=near" aria-current={tab === 'near' ? 'page' : undefined}>
            Open requests near you{near.items.length ? <span className="count">{near.items.length}</span> : null}
          </Link>
          <Link href="/settings/organization/profile">Profile</Link>
        </nav>
        {sp.done ? <p className="mkt-note" role="status" style={{ maxWidth: 'none', marginBottom: 12 }}>{sp.done}</p> : null}
        {sp.error ? <p className="mkt-error" role="alert" style={{ maxWidth: 'none', marginBottom: 12 }}>{sp.error}</p> : null}

        {tab === 'for-you' ? (
          forYou.length === 0 ? (
            <div className="mkt-empty">
              <p>No requests yet. Owners and contractors find you in the directory, or invite you by email.</p>
              <Link className="btn" href="/settings/organization/profile">Complete your profile</Link>
            </div>
          ) : (
            <ul className="mkt-list">
              {forYou.map((r) => {
                const st = requestState(r);
                return (
                  <li key={r.recipient_id} className="mkt-card">
                    <div className="mkt-card-main">
                      <h2 className="mkt-card-title">{r.title}{r.build?.name ? ` — ${r.build.name}` : ''}</h2>
                      <p className="mkt-deadline">{originLine(r)}</p>
                    </div>
                    <div className="mkt-card-side">
                      <span className={`badge ${st.tone}`}>{st.label}</span>
                      <div className="mkt-actions">
                        {st.canPrice ? <Link className="btn primary sm" href={`/requests/${r.rfp_id}`}>Open and price</Link> : null}
                        {st.canDecline ? (
                          <form action={declineInvitationAction}>
                            <input type="hidden" name="rfp_id" value={r.rfp_id} />
                            <button type="submit" className="btn sm">Decline</button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : near.profileMissing ? (
          <div className="mkt-empty">
            <p>Open requests are matched on your directory profile: your specialties and where you work.</p>
            <Link className="btn primary" href="/settings/organization/profile">Set up your public profile</Link>
          </div>
        ) : near.items.length === 0 ? (
          <div className="mkt-empty"><p>No open requests match your specialties and service area right now.</p></div>
        ) : (
          <ul className="mkt-list">
            {near.items.map((o) => {
              const act = openRequestAction(o);
              return (
                <li key={o.rfp_id} className="mkt-card">
                  <div className="mkt-card-main">
                    <h2 className="mkt-card-title">{o.title}</h2>
                    <p className="mkt-deadline">{openRequestLine(o)}</p>
                  </div>
                  <div className="mkt-card-side">
                    {act.kind === 'ask' ? (
                      <form action={askToBidAction}>
                        <input type="hidden" name="rfp_id" value={o.rfp_id} />
                        <button type="submit" className="btn primary sm">Ask to bid</button>
                      </form>
                    ) : act.open ? (
                      <Link className="btn primary sm" href={`/requests/${o.rfp_id}`}>{act.label}</Link>
                    ) : (
                      <span className={`badge ${act.tone}`}>{act.label}</span>
                    )}
                    {act.kind === 'ask' ? <p className="mkt-note">The owner approves each company before it gets a link.</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PortalShell>
  );
}
