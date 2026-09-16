// `/plan/build` is retired as a route (LINA-281, ADR-0023 §4). Direct plan
// authoring folded into the single `/plan` accordion: the editor now renders
// inline in the Execution section via `?compose=build`. This shell survives only
// to 307-redirect any existing in-app link or bookmark to that in-page action —
// the editor itself lives in ./PlanBuildEditor, still imported by the plan page.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PlanBuildRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/plan?compose=build`);
}
