// /rfp/[token]/submitted — the proposal confirmation (LINA-284, ADR-0023 §6).
//
// Same two server-side jobs as the form page, for the same reasons: keep the
// credential-bearing URL out of every index and cache, and unwrap the param. The
// read-back lives in SubmittedClient, because it is authenticated by the scoped
// cookie the browser holds — not by anything this process can see.
import type { Metadata } from 'next';

import { SubmittedClient } from './SubmittedClient';

export const metadata: Metadata = {
  title: 'Proposal submitted · LinkNMS',
  robots: { index: false, follow: false, nosnippet: true, noarchive: true },
};

export default async function RfpSubmittedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SubmittedClient token={token} />;
}
