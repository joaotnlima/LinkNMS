// /marketplace/bid/{rfpId} — retired (PRD-04 X-12): the proposal for that RFP
// lives in the company inbox, at /requests/{rfpId}.
import { redirect } from 'next/navigation';

export default async function MarketplaceBidPage({ params }: { params: Promise<{ rfpId: string }> }): Promise<never> {
  const { rfpId } = await params;
  redirect(`/requests/${encodeURIComponent(rfpId)}`);
}
