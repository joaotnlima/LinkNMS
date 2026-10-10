// /settings/organization/profile — RESERVED for the public company profile
// editor (PRD-03 R-20, what /companies/{slug} shows). PRD-12 only links here;
// the editor itself ships with the company directory.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import { sessionState } from '@/server/session';

import { SettingsFrame } from '../../SettingsFrame';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Company profile · LinkNMS' };

export default async function CompanyProfilePlaceholder() {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/settings/organization/profile');
  if (state.kind === 'unseated') redirect('/no-access');
  const profile = await getViewerProfile();
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  return (
    <SettingsFrame user={user} tab="organization">
      <section className="set-card">
        <h2>Public company profile</h2>
        <p>
          The profile other companies and owners see in the directory — specialties, service area, portfolio —
          is edited here once the company directory opens.
        </p>
        <p><Link className="set-link" href="/settings/organization">Back to organisation settings</Link></p>
      </section>
    </SettingsFrame>
  );
}
