// /requests/{rfpId} — one request in the company inbox (PRD-04 X-11): the
// package to price, the in-app bid editor and the clarifications. Since D-47
// this never claims a lane — only a company holding an invite (from the
// directory, by email, or an approved request to bid) prices here; the
// personal e-mailed link (/rfp/{token}) remains the other door.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { askClarificationAction } from '@/components/procurement-actions';
import { BidderClarifications } from '@/components/tender/Clarifications';
import { loadBidContext } from '@/lib/v2/company-inbox';
import { getViewerProfile } from '@/lib/v2/profile';
import { originLine } from '@/lib/v2/rfp-directory-view';
import { sessionState } from '@/server/session';

import { BidEditor } from './BidEditor';
import '../requests.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Price a request · LinkNMS' };

export default async function RequestPage({ params }: { params: Promise<{ rfpId: string }> }) {
  const { rfpId } = await params;
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect(`/sign-in?next=/requests/${encodeURIComponent(rfpId)}`);
  if (state.kind === 'unseated') redirect('/no-access');
  if (!state.session.setupComplete) redirect('/onboarding/setup');

  const [profile, ctx] = await Promise.all([getViewerProfile(), loadBidContext(rfpId)]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };

  return (
    <PortalShell user={user} switcherLabel="Requests" align="start">
      {ctx.ok ? (
        <>
          <div className="mkt" style={{ paddingBottom: 0 }}>
            <p className="mkt-deadline">{originLine(ctx.ctx.request)}</p>
          </div>
          <BidEditor rfp={ctx.ctx.rfp} lane={ctx.ctx.lane} />
          {/* PRD-08 H-6: ask the issuer in-app; answers are public to every bidder. */}
          <div className="mkt" style={{ marginTop: 24 }}>
            <BidderClarifications
              items={ctx.ctx.rfp.clarifications ?? []}
              questionsOpen={ctx.ctx.rfp.questions_open ?? false}
              questionsDeadline={ctx.ctx.rfp.questions_deadline ?? null}
              rfpStatus={ctx.ctx.rfp.status}
              ask={askClarificationAction.bind(null, ctx.ctx.rfp.id)}
            />
          </div>
        </>
      ) : (
        <div className="mkt">
          <div className="mkt-empty">
            <p>{ctx.message}</p>
            <Link className="btn" href="/requests?tab=near">Open requests near you</Link>
          </div>
        </div>
      )}
    </PortalShell>
  );
}
