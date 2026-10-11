// /marketplace — retired (PRD-04 X-12, D-47). The inverted marketplace let a
// company claim a bid lane on any open RFP; open requests now need the owner's
// approval, and the company inbox's "Open requests near you" replaces it.
import { redirect } from 'next/navigation';

export default function MarketplacePage(): never {
  redirect('/requests?tab=near');
}
