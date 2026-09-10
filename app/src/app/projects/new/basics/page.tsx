// M2/D2 — "New build · Basics", step 1 of the 3-step wizard (LINA-179;
// pen-rebuilt LINA-219; moved under /projects/new/basics by LINA-227).
//
// Pen source: cowork/pen/linkNMS.pen (republished c6276a3) → the "New build"
// flow, screen "Basics (1 of 3)" — "What are we building?".
//
// The build IS the project (ADR-0011 decision 1) — hence no new route family and
// no second noun in the URL. The screen says "build" because that is what the
// creator calls the thing; `/projects/*` stays because that is what the record is.
//
// This submit creates the build as a DRAFT (ADR-0011 decision 2): a creator who
// closes the tab at step 2 has a build to come back to rather than nothing.
//
// WHO IS CREATING (LINA-227, ADR-0016). The pre-Basics "Your role" screen at
// `/projects/new` picks owner vs general contractor and carries the choice here
// as `?as=owner|counterparty`. It is echoed as a hidden `creatorRole` field so
// the submit sends it, and it drives the lede so the screen reads correctly for a
// GC creator too — the Basics copy no longer assumes the creator is the owner.
// A missing/invalid `as` falls back to 'owner', the service default, so a direct
// hit on this URL is the legacy owner path unchanged.
//
// PEN LAYOUT (LINA-219). The card carries its own title, then Build name,
// Address, and Build type + Expected start as a two-up row. The primary sits
// BELOW the card, right aligned, via WizardNav.
//
// BASELINE BUDGET IS GONE FROM THIS SCREEN (LINA-219). The plan is now the
// baseline's source (import seeds the proposal, the accepted plan sets the
// figure). A draft is created with a 0 baseline and the plan establishes the real
// number, so nothing is typed twice. See the GAPS note in @/lib/build-creation.
//
// Expected start is a month PICKER (pen), not a free date input: the value is the
// same "YYYY-MM" string the column already stored.
import { redirect } from 'next/navigation';
import { WizardChrome } from '@/components/WizardChrome';
import { WizardSteps } from '@/components/WizardSteps';
import { isSignedIn } from '@/lib/api';
import { expectedStartOptions, isCreatorRole } from '@/lib/build-creation';
import { BasicsForm } from './BasicsForm';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function NewBuildBasicsPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const { as } = await searchParams;
  if (!(await isSignedIn())) {
    // Preserve the role choice across sign-in so a fresh visitor lands back on
    // the right creator path.
    const next = `/projects/new/basics${isCreatorRole(as) ? `?as=${as}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  // Default to owner: the common case, the service default, and what a direct
  // hit on this URL (no `?as`) means.
  const creatorRole = isCreatorRole(as) ? as : 'owner';

  // Computed on the server at request time so the list always starts from the
  // current month; the value is "YYYY-MM", the label is "March 2026".
  const months = expectedStartOptions(new Date());

  return (
    <WizardChrome>
      <WizardSteps current="basics" />
      <BasicsForm creatorRole={creatorRole} months={months} />
    </WizardChrome>
  );
}
