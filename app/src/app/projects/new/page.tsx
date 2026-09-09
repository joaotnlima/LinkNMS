// M2/D2 — "New build · Basics", step 1 of Band B (LINA-179; pen-aligned LINA-219).
//
// Pen source: cowork/pen/linkNMS.pen → "Band B · Create the build and invite",
// screen "D2 · New build · Basics (1 of 3)".
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
// PEN FIELDS NOW PRESENT (LINA-219): the pen's Basics screen draws Build name,
// Address, Build type and Expected start. All four render here; migration 0014
// added the columns so what the owner types is persisted and stamped into the
// genesis event, not discarded. Baseline budget is an EXTRA field the pen does
// not draw — a deliberate departure, because `createProject` needs the baseline
// every later claim is measured against and nothing re-baselines a live build.
// See the GAPS note in @/lib/build-creation.
import { redirect } from 'next/navigation';
import { TopBar } from '@/components/chrome';
import { ActionForm } from '@/components/ActionForm';
import { WizardSteps } from '@/components/WizardSteps';
import { createBuildAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';
import { BUILD_TYPES } from '@/lib/build-creation';
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
          <h1 className="bw-title">What are we building?</h1>
          <p className="bw-lede">
            You are the owner. Name the build and set the baseline budget — the agreed starting
            figure every change is measured against. It never moves on its own; only an approved
            change order can move it.
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
                placeholder="e.g. Casa da Encosta — Sintra"
                aria-describedby="name-help"
              />
              <span id="name-help" className="hint">
                What both of you will call it. You can rename it later.
              </span>
            </label>

            <label className="field">
              <span className="metric-lbl">Address</span>
              <input
                name="siteAddress"
                type="text"
                maxLength={300}
                autoComplete="off"
                placeholder="Rua da Encosta 14, 2710 Sintra"
                aria-describedby="address-help"
              />
              <span id="address-help" className="hint">
                Where the work is. Optional — you can add it later.
              </span>
            </label>

            <label className="field">
              <span className="metric-lbl">Build type</span>
              <select name="buildType" defaultValue="" aria-describedby="type-help">
                <option value="">Choose a type…</option>
                {BUILD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span id="type-help" className="hint">
                Optional. Helps the contractor recognise the build.
              </span>
            </label>

            <label className="field">
              <span className="metric-lbl">Expected start</span>
              <input
                name="expectedStart"
                type="month"
                aria-describedby="start-help"
              />
              <span id="start-help" className="hint">
                Optional. The month you expect work to begin — a target, not a commitment.
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
