// /projects/{id}/plan/procurement — retired (PRD-08 H-4). Tendering lives at
// its own address now (to-be/20 §3). Old links keep working (acceptance 3):
//   ?rfp=R              → /projects/{id}/tendering/rfps/R
//   ?rfp=R&compare=a,b  → /projects/{id}/tendering/rfps/R/proposals?compare=a,b
//   ?task=T[&mode=]     → /projects/{id}/tendering/rfps/new?task=T[&mode=light]
//   (bare)              → /projects/{id}/tendering
// The mapping is the pure `legacyProcurementTarget` (unit-tested).
import { redirect } from 'next/navigation';

import { legacyProcurementTarget } from '@/lib/v2/tendering-home-view';

export const dynamic = 'force-dynamic';

export default async function LegacyProcurementPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rfp?: string; compare?: string; task?: string; mode?: string }>;
}) {
  const { id } = await params;
  redirect(legacyProcurementTarget(id, await searchParams));
}
