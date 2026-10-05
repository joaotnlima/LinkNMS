// /marketplace/bid/[rfpId] — price and send a bid on an open RFP (LINA-406,
// Slice 3). The discovery surface (Slice 2) ends at "lane claimed"; this is the
// screen that turns a claimed lane into a real figure the issuer can compare.
//
// It reuses the marketplace's exact session gate (seated, set-up party) so there
// is one story about who gets in. `loadBidContext` does the work: it reads the
// RFP (readable by any bidder while it is open, D-15) and idempotently claims /
// re-resolves this org's lane, so arriving here by a direct link works whether or
// not the org had already pressed Apply. A refused apply (window closed, the
// issuer's own RFP) renders inline — never a crash, never a false editor.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { loadBidContext } from '@/lib/v2/marketplace';
import { getViewerProfile } from '@/lib/v2/profile';
import { sessionState } from '@/server/session';

import { BidEditor } from './BidEditor';
import '../../marketplace.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Place a bid · LinkNMS',
};

export default async function BidPage({
  params,
}: {
  params: Promise<{ rfpId: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in');
  if (state.kind === 'unseated') redirect('/no-access');
  if (!state.session.setupComplete) redirect('/onboarding/setup');

  const { rfpId } = await params;
  const [profile, ctx] = await Promise.all([getViewerProfile(), loadBidContext(rfpId)]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };

  return (
    <PortalShell user={user} switcherLabel="Marketplace" align="start">
      {ctx.ok ? (
        <BidEditor rfp={ctx.ctx.rfp} lane={ctx.ctx.lane} />
      ) : (
        <div className="mkt">
          <div className="mkt-empty">
            <p>{ctx.message}</p>
            <Link className="btn" href="/marketplace">Back to marketplace</Link>
          </div>
        </div>
      )}
    </PortalShell>
  );
}
