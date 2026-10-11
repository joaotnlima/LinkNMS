// /companies/{slug}/claim — start claiming an unclaimed profile (PRD-03 R-16).
// Signed-in, acting for the company: we mail a single-use link to the e-mail
// the profile was created from; only that link completes the claim.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { DirectoryFrame } from '@/components/directory/DirectoryFrame';
import { getCompanyBySlug } from '@/lib/v2/directory';
import { sessionState } from '@/server/session';

import { startClaimAction } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Claim a company profile · LinkNMS', robots: { index: false } };

export default async function ClaimStartPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const [{ slug }, { sent, error }, state] = await Promise.all([params, searchParams, sessionState()]);
  if (state.kind === 'anonymous') redirect(`/sign-in?next=/companies/${slug}/claim`);
  const profile = await getCompanyBySlug(slug);
  if (!profile) notFound();

  return (
    <DirectoryFrame on={null} signedIn>
      <div className="dprof" style={{ maxWidth: 640 }}>
        <Link href={`/companies/${slug}`} style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← {profile.display_name}</Link>
        <h1>Claim {profile.display_name}</h1>
        {!profile.claim.available ? (
          <p>This profile is already managed by its company.</p>
        ) : sent ? (
          <p role="status">We sent a link to <b>{sent}</b>. Open it while signed in with this organisation to finish — it is valid for 7 days.</p>
        ) : (
          <form action={startClaimAction} className="sec2">
            <p className="cap" style={{ fontSize: 13 }}>
              To prove the profile is yours, we send a link to the e-mail address LinkNMS knows this company by. Only
              that link completes the claim, for the organisation you are acting for now.
            </p>
            <input type="hidden" name="org_id" value={profile.org_id} />
            <input type="hidden" name="slug" value={slug} />
            <p><button type="submit" className="btn primary">Send the claim link</button></p>
          </form>
        )}
        {error ? <p className="derr" role="alert">{error}</p> : null}
      </div>
    </DirectoryFrame>
  );
}
