'use server';

// The one write the marketplace browser makes (LINA-406): claim a bid lane on an
// open RFP. A server action, not a browser fetch — the v2 client is server-only
// (it dispatches the tendering module in-process), so the apply crosses to the
// server here. On success we revalidate the listing so the card flips to its
// "Applied" state in place; the refused cases (deadline passed, the issuer's own
// RFP) come back as a message the browser renders inline.
import { revalidatePath } from 'next/cache';

import { applyToOpenRfp } from '@/lib/v2/marketplace';

export type ApplyActionState =
  | { ok: true; proposalId: string }
  | { ok: false; error: string };

export async function applyAction(rfpId: string): Promise<ApplyActionState> {
  const res = await applyToOpenRfp(rfpId);
  if (!res.ok) return { ok: false, error: res.message };
  // The listing's "Applied" marker is derived from /me/rfps, which now includes
  // this RFP — revalidate so a reload (or the next navigation) shows the truth.
  revalidatePath('/marketplace');
  return { ok: true, proposalId: res.lane.proposal_id };
}
