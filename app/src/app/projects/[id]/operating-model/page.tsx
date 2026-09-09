// M3/D3 — "New build · Operating model", step 2 of Band B (LINA-179; pen-rebuilt
// LINA-219).
//
// Pen source: the "New build" flow, screen "Operating model (2 of 3)" — "How is
// this build contracted?". The Turnkey / Direct-to-specialty / Hybrid choice is
// captured here and never asked again, because it shapes who may be invited and
// who has to approve what for the life of the build (ADR-0011 decision 1). The
// screen says so: "This shapes who you invite and who fills in the plan. You will
// not be asked again."
//
// Two guards, both of which turn a would-be 4xx into a sensible screen. The
// service remains the authority on each (owner-only, draft-only):
//   * not the owner  → their own build page. This is a wizard the owner is in
//                      the middle of; a joined GC landing here has nothing to do.
//   * already active → the build page. The model is fixed once the first invite
//                      commits the build, and the PATCH would 409.
import { redirect } from 'next/navigation';

import { WizardChrome } from '@/components/WizardChrome';
import { WizardSteps } from '@/components/WizardSteps';
import { OperatingModelPicker } from './OperatingModelPicker';
import { getBuild } from '@/lib/api';
import { stepFor, type OperatingModel } from '@/lib/build-creation';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function OperatingModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const build = await getBuild(id);

  if (build.actingRole !== 'owner') redirect(`/projects/${id}`);
  // `stepFor` is the one place that reads the draft truth table. 'invite' is NOT
  // redirected: stepping back to change the model before committing is legitimate
  // and the service allows it (the build is still a draft).
  if (stepFor(build) === 'done') redirect(`/projects/${id}`);

  return (
    <WizardChrome>
      <WizardSteps current="model" />

      <OperatingModelPicker
        projectId={id}
        selected={(build.operatingModel ?? null) as OperatingModel | null}
      />
    </WizardChrome>
  );
}
