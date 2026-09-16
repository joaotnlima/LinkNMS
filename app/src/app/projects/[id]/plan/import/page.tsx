// `/plan/import` is retired as a route (LINA-281, ADR-0023 §4). The import wizard
// folded into the single `/plan` accordion: it now renders inline in the
// Execution section via `?compose=import`. This shell survives only to
// 307-redirect any existing in-app link or bookmark to that in-page action — the
// wizard itself lives in ./PlanImportWizard, still imported by the plan page.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PlanImportRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/plan?compose=import`);
}
