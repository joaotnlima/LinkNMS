// /rfp/[token] — the public, token-gated proposal form (LINA-284, ADR-0023 §6).
//
// This file is deliberately almost empty. It exists to do the two things that
// must happen on the SERVER, and then hand over:
//
//   1. `noindex, nofollow`. The URL contains a live credential. A page carrying
//      one that a crawler can index is how a token ends up in a search result,
//      and there is no revoking it afterwards — the whole point of ADR-0023 §5
//      is that the token IS the credential. `nosnippet`/`noarchive` are included
//      for the same reason: a cached copy of a scope of works for someone's
//      private house is not ours to leave lying around.
//   2. Unwrap the route param.
//
// The read itself, the cookie it mints, and every state the page can be in live
// in ProposalClient — see the header comment there for why that read cannot
// happen here.
//
// There is NO middleware entry for this path and that is correct: `/rfp` is
// absent from `isProtectedRoute` in src/middleware.ts, so Clerk attaches
// whatever session state exists (usually none) and never redirects. Nothing
// needs adding — a rule that granted access here would be a rule that could be
// got wrong.
import type { Metadata } from 'next';

import { ProposalClient } from './ProposalClient';

export const metadata: Metadata = {
  title: 'Submit a proposal · LinkNMS',
  robots: { index: false, follow: false, nosnippet: true, noarchive: true },
};

export default async function RfpTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ProposalClient token={token} />;
}
