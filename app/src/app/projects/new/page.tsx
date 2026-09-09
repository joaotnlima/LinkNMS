// M2/D2 — "New build · Basics", step 1 of Band B (LINA-179; pen-rebuilt LINA-219).
//
// Pen source: cowork/pen/linkNMS.pen (republished c6276a3) → the "New build"
// flow, screen "Basics (1 of 3)" — "What are we building?".
//
// The build IS the project (ADR-0011 decision 1) — hence no new route family and
// no second noun in the URL. The screen says "build" because that is what the
// owner calls the thing; `/projects/*` stays because that is what the record is.
//
// This submit creates the build as a DRAFT (ADR-0011 decision 2): an owner who
// closes the tab at step 2 has a build to come back to rather than nothing.
//
// PEN LAYOUT (LINA-219). The card carries its own title, then Build name,
// Address, and Build type + Expected start as a two-up row. There is no lede and
// no per-field hint text — the pen keeps the card terse, and the field labels
// plus placeholders carry the meaning. The primary sits BELOW the card, right
// aligned, via WizardNav.
//
// BASELINE BUDGET IS GONE FROM THIS SCREEN (LINA-219). The old Basics collected
// it; the pen does not, and post-Slices-B1–B3 it should not — the plan is now the
// baseline's source (import seeds the proposal, the accepted plan sets the
// figure). A draft is created with a 0 baseline and the plan establishes the real
// number, so nothing is typed twice and no live build carries a guessed baseline.
// See the GAPS note in @/lib/build-creation.
//
// Expected start is a month PICKER (pen), not a free date input: the value is the
// same "YYYY-MM" string the column already stored, so nothing downstream changed
// — only the control the owner sees.
import { redirect } from 'next/navigation';
import { WizardChrome } from '@/components/WizardChrome';
import { WizardSteps } from '@/components/WizardSteps';
import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { ActionForm } from '@/components/ActionForm';
import { createBuildAction } from '@/app/actions';
import { isSignedIn } from '@/lib/api';
import { BUILD_TYPES, expectedStartOptions } from '@/lib/build-creation';
import '../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function NewBuildPage() {
  if (!(await isSignedIn())) redirect('/sign-in?next=/projects/new');

  // Computed on the server at request time so the list always starts from the
  // current month; the value is "YYYY-MM", the label is "March 2026".
  const months = expectedStartOptions(new Date());

  return (
    <WizardChrome>
      <WizardSteps current="basics" />

      <ActionForm
        action={createBuildAction}
        submitLabel="Continue"
        pendingLabel="Creating…"
        footer={({ pending }) => (
          <WizardNav>
            <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Continue'}
              <ArrowRight />
            </button>
          </WizardNav>
        )}
      >
        <section className="bwx-card">
          <h1 className="bwx-card-title">What are we building?</h1>

          <label className="field">
            <span className="metric-lbl">Build name</span>
            <input
              name="name"
              type="text"
              required
              maxLength={200}
              autoComplete="off"
              placeholder="Casa da Encosta — Sintra"
            />
          </label>

          <label className="field">
            <span className="metric-lbl">Address</span>
            <input
              name="siteAddress"
              type="text"
              maxLength={300}
              autoComplete="off"
              placeholder="Rua da Encosta 14, 2710 Sintra"
            />
          </label>

          <div className="bwx-row2">
            <label className="field">
              <span className="metric-lbl">Build type</span>
              <select name="buildType" defaultValue="">
                <option value="">Choose a type…</option>
                {BUILD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="metric-lbl">Expected start</span>
              <select name="expectedStart" defaultValue="">
                <option value="">Choose a month…</option>
                {months.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      </ActionForm>
    </WizardChrome>
  );
}
