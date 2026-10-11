// /companies/{slug}/claim/{token} — the e-mailed link (PRD-03 R-16). Opening
// it changes nothing: the signed-in company confirms with a POST.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DirectoryFrame } from '@/components/directory/DirectoryFrame';
import { sessionState } from '@/server/session';

import { acceptClaimAction } from '../../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Confirm the claim · LinkNMS', robots: { index: false } };

export default async function ClaimAcceptPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string; token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ slug, token }, { error }, state] = await Promise.all([params, searchParams, sessionState()]);
  if (state.kind === 'anonymous') redirect(`/sign-in?next=/companies/${slug}/claim/${encodeURIComponent(token)}`);
  return (
    <DirectoryFrame on={null} signedIn>
      <div className="dprof" style={{ maxWidth: 640 }}>
        <h1>Confirm the claim</h1>
        <form action={acceptClaimAction} className="sec2">
          <p className="cap" style={{ fontSize: 13 }}>
            The profile becomes the profile of the organisation you are acting for now — the same one that asked for
            this link. You can then edit it in your company settings.
          </p>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="token" value={token} />
          <p><button type="submit" className="btn primary">Claim the profile</button></p>
        </form>
        {error ? <p className="derr" role="alert">{error}</p> : null}
      </div>
    </DirectoryFrame>
  );
}
