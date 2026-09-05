// M2/D2 — "New build · Basics", step 1 of Band B (LINA-179).
//
// Pen source: cowork/pen/linkNMS-flows.pen → Bootstrap Flow Board, screen 02.
//
// WHAT CHANGED FROM THE R0 SCREEN. This route used to be a one-shot "Start a
// project" form that created a fully-formed, live project and jumped straight to
// the invite step. Band B is the same entry point (EmptyPortal's "Create your
// first build" CTA has always pointed here) but a three-step, DRAFT-FIRST wizard:
// this submit creates the build as a draft (ADR-0011 decision 2), so an owner who
// closes the tab at step 2 has a build to come back to rather than nothing.
//
// The build IS the project (ADR-0011 decision 1) — hence no new route family and
// no second noun in the URL. The screen says "build" because that is what the
// owner calls the thing; `/projects/*` stays because that is what the record is.
//
// TWO PEN FIELDS ARE DELIBERATELY ABSENT: "Site address" and "Build type".
// Migration 0009 added `operating_model` and `status` to identity.project and
// nothing else, so both would be inputs whose contents the server discards. See
// the GAPS note in @/lib/build-creation. The baseline budget takes their place
// because `createProject` requires it and it is the number every later claim is
// measured against.
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { WizardSteps } from '@/components/WizardSteps';
import { createBuildAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';
import '../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function NewBuildPage() {
  if (!(await isSignedIn())) redirect('/sign-in?next=/projects/new');

  return (
    <>
      <TopBar back={{ href: '/', label: 'Home' }} />
      <main className="bw">
        <WizardSteps current="basics" />

        <div className="bw-head">
          <h1 className="bw-title">Name your build</h1>
          <p className="bw-lede">
            You are the owner. The baseline budget you set here is what every change is measured
            against — it never moves on its own, and only an approved change order can move it.
          </p>
        </div>

        <section className="bw-card">
          <ActionForm
            action={createBuildAction}
            submitLabel="Continue"
            pendingLabel="Creating…"
          >
            <label className="field">
              <span className="metric-lbl">Build name</span>
              <input
                name="name"
                type="text"
                required
                maxLength={200}
                autoComplete="off"
                placeholder="e.g. Maple Street rebuild"
                aria-describedby="name-help"
              />
              <span id="name-help" className="hint">
                What both of you will call it. You can rename it later.
              </span>
            </label>

            <label className="field">
              <span className="metric-lbl">Baseline budget</span>
              <input
                name="baselineBudget"
                type="text"
                inputMode="decimal"
                required
                placeholder="250000.00"
                aria-describedby="baseline-help"
              />
              <span id="baseline-help" className="hint">
                The agreed starting figure. Only an approved change order can move it.
              </span>
            </label>
          </ActionForm>

          <p className="bw-once">
            Nothing is shared yet. Your build stays private to you until you invite someone on the
            last step.
          </p>
        </section>
      </main>
    </>
  );
}
