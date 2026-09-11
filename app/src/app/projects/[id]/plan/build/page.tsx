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

import { getBuild, getPlan, getPlanTemplate, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { hydrateDraft, type PhaseDraft, type TemplatePhase } from '@/lib/plan-authoring';
import { directoryOf } from '@/lib/view';
import { UNKNOWN_PARTY, type PartyRef } from '@/lib/party-display';
import { PlanBuildEditor } from './PlanBuildEditor';

export const dynamic = 'force-dynamic';

export default async function PlanBuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/plan/build`);

  const [build, plan, template] = await Promise.all([getBuild(id), getPlan(id), resolveTemplate()]);
  const shell = await buildShellContext(id, build.name);

  // "Keep editing" resumes the saved draft. getPlan surfaces a draft to its
  // author ONLY (LINA-230), so if `current` is a draft it is this signed-in
  // party's to resume; otherwise the editor scaffolds from `template`.
  //
  // ORDER MATTERS: a saved draft always wins. The template is a starting point
  // for a plan that does not exist yet — scaffolding over work the author already
  // saved would silently discard it.
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
      <PlanBuildEditor projectId={id} initialPhases={draft} templateBody={template} parties={parties} />
    </PortalShell>
  );
}

/**
 * The resolved default scaffold (LINA-242), or undefined if it could not be read.
 *
 * A template is a convenience, not a permission or a record: if the endpoint is
 * unreachable the author must still get a working editor, so a failure here
 * degrades to `undefined` and the editor falls back to its built-in PLAN_SKELETON
 * rather than turning a scaffold outage into an error page on the build itself.
 * Deliberately swallowed and logged, never rethrown.
 */
async function resolveTemplate(): Promise<TemplatePhase[] | undefined> {
  try {
    const resolved = await getPlanTemplate();
    return resolved.body?.length ? resolved.body : undefined;
  } catch (err) {
    console.warn('[plan/build] could not resolve the default plan template', err);
    return undefined;
  }
}
