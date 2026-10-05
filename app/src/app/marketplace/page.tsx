// /marketplace — the open-marketplace discovery surface (LINA-406, "#2").
//
// The first screen that lets a company DISCOVER tendering work it was never
// emailed about. The backend has long published every open RFP
// (`GET /marketplace/rfps`, D-15) and a self-serve claim
// (`POST /rfps/{id}:apply`, Slice 1) — nothing in the UI reached either, so an
// RFP marked "open to the marketplace" was invisible. This page is that reach:
// browse the open listing, filter by specialty, and claim a bid lane on one.
//
// ── SESSION GATE (same three answers as the portal root) ──────────────────────
// A marketplace read is org-scoped (doc 16 §4): it needs a seated, set-up party.
// We reuse the home page's exact gate — anonymous → sign-in, unseated → no-access
// — rather than invent a second one, so there is one story about who gets in.
//
// ── FAIL-CLOSED, ORG-SCOPED ──────────────────────────────────────────────────
// Both reads fail closed to [] (see `lib/v2/marketplace.ts`): a viewer with no
// active org, or one without `org:tendering:bid`, sees an honest empty listing,
// never a crash and never a leak of an RFP's existence. The two reads are
// independent, so they run concurrently.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import {
  browseOpenMarketplace,
  listMyApplications,
} from '@/lib/v2/marketplace';
import { sessionState } from '@/server/session';

import { MarketplaceBrowser } from './MarketplaceBrowser';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Marketplace · LinkNMS',
};

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ specialty?: string; q?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in');
  if (state.kind === 'unseated') redirect('/no-access');
  if (!state.session.setupComplete) redirect('/onboarding/setup');

  const { specialty, q } = await searchParams;

  const [profile, open, mine] = await Promise.all([
    getViewerProfile(),
    browseOpenMarketplace({ specialty, municipality: q }),
    listMyApplications(),
  ]);

  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  // The RFP ids this org already holds a lane on (invited or applied) — the card
  // shows "Applied" instead of a second Apply button for these.
  const appliedRfpIds = new Set(mine.map((r) => r.id));

  return (
    <PortalShell user={user} switcherLabel="Marketplace" align="start">
      <MarketplaceBrowser
        rfps={open}
        appliedRfpIds={[...appliedRfpIds]}
        activeSpecialty={specialty ?? ''}
      />
    </PortalShell>
  );
}
