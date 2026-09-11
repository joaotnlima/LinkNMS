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

import { getBuild, getPlan, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { hydrateDraft, type PhaseDraft } from '@/lib/plan-authoring';
import { directoryOf } from '@/lib/view';
import { UNKNOWN_PARTY, type PartyRef } from '@/lib/party-display';
import { PlanBuildEditor } from './PlanBuildEditor';

export const dynamic = 'force-dynamic';

export default async function PlanBuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/build`);

  const [build, plan] = await Promise.all([getBuild(id), getPlan(id)]);
  const shell = await buildShellContext(id, build.name);

  // "Keep editing" resumes the saved draft. getPlan surfaces a draft to its
  // author ONLY (LINA-230), so if `current` is a draft it is this signed-in
  // party's to resume; otherwise the editor seeds the standard skeleton.
  const draft: PhaseDraft[] | undefined =
    plan.current?.status === 'draft' ? hydrateDraft(plan.current.stages) : undefined;

  // The assignee picker's whole universe (LINA-246). It is THIS build's members
  // and nothing else: the schedule service checks membership on every authored
  // assignee and answers `400 unknown_assignee` otherwise, so offering anyone
  // else would be offering a refusal. Names are resolved here, server-side, from
  // the project payload the page already fetched — never by a cross-service
  // party lookup (ADR-0006 §1).
  const directory = directoryOf(build);
  const parties: PartyRef[] = build.members.map((m) => ({
    partyId: m.partyId,
    name: directory.get(m.partyId)?.name ?? UNKNOWN_PARTY,
    role: m.role,
  }));

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="plan"
    >
      <PlanBuildEditor projectId={id} initialPhases={draft} parties={parties} />
    </PortalShell>
  );
}
