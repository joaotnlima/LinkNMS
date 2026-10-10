// `/plan/build` is retired as a route (LINA-281, ADR-0023 §4). Direct plan
// authoring IS the `/plan` screen now: `/plan` mounts ./PlanBuildEditor directly
// for every build that is not baselined. This shell survives only to redirect an
// old link or bookmark there — plainly, with no `?compose=` flag, because `/plan`
// reads no such parameter (PRD-01 C-1).
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PlanBuildRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/plan`);
}
