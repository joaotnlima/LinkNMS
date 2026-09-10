// "Build the plan here" — the direct-authoring route (LINA-228, ADR-0017).
//
// The sibling of plan/import: a thin server shell that proves a session, names
// the build for the switcher + breadcrumb, and hands the seeded skeleton to the
// client editor that holds the draft. The authorization that matters is NOT
// here — PROPOSE_PLAN is decided in the schedule service on the one `:author`
// write (contract §0–§3), so a party who cannot author gets a typed refusal
// from the server rather than a screen this file chose to withhold. Either
// project party may author (ADR-0017 §3), so there is no role gate here; the
// redirect below is routing convenience, never a security control.
//
// CHROME (LINA-224): the rail, not a takeover. Authoring is one operation on an
// already-live build, so it wears PortalShell BUILD mode under section "plan",
// exactly as import does.
import { redirect } from 'next/navigation';

import { getBuild, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { PlanBuildEditor } from './PlanBuildEditor';

export const dynamic = 'force-dynamic';

export default async function PlanBuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/build`);

  const build = await getBuild(id);
  const shell = await buildShellContext(id, build.name);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <PlanBuildEditor projectId={id} />
    </PortalShell>
  );
}
