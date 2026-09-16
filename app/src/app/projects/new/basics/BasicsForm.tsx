'use client';

// The Basics-step form body (M2/D2, step 1 of 3).
//
// A client component only because it lives inside ActionForm, which owns the
// `footer` render-prop (LINA-219) that puts the Back / Continue nav BELOW the
// card while keeping the button the form's real submit with the live `pending`
// flag. A render-prop is a function, and a function cannot cross the
// server→client boundary as a prop — so the ActionForm caller must itself be a
// client component (LINA-231). This mirrors InvitePanel and OperatingModelPicker;
// Basics was the lone step inlining ActionForm in its server page, which is what
// crashed `/projects/new/basics` with the RSC "Functions cannot be passed
// directly to Client Components" error.
//
// The server page still owns everything server-only (auth gate, the role choice,
// and the request-time month list) and hands it here as serializable props.
import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { ActionForm } from '@/components/ActionForm';
import { createBuildAction } from '@/app/actions';
import { BUILD_TYPES, BASICS_LEDE, type CreatorRole } from '@/lib/build-creation';

export function BasicsForm({
  creatorRole,
  months,
}: {
  creatorRole: CreatorRole;
  /** "YYYY-MM" value + "March 2026" label, computed on the server at request time. */
  months: readonly { value: string; label: string }[];
}) {
  return (
    <ActionForm
      action={createBuildAction}
      submitLabel="Continue"
      pendingLabel="Creating…"
      footer={({ pending }) => (
        <WizardNav back={{ href: '/projects/new' }}>
          <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
            {pending ? 'Creating…' : 'Continue'}
            <ArrowRight />
          </button>
        </WizardNav>
      )}
    >
      {/* The creator role chosen on the "Your role" screen. The server action
          validates it and the service defaults/validates again — this field is
          a carrier, never trusted as a membership claim. */}
      <input type="hidden" name="creatorRole" value={creatorRole} />

      <section className="bwx-card">
        <h1 className="bwx-card-title">What are we building?</h1>
        <p className="bwx-card-sub">{BASICS_LEDE[creatorRole]}</p>

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

        {/* "Do you already have a signed contractor?" (LINA-281, ADR-0023 §3).
            The answer is seed-time only: it decides which phase the build opens
            in — "No" runs an RFP first (procurement active); "Yes" skips the
            tender and starts the Execution plan. Two native radios so selection
            reads by the mark and the focus ring, never colour alone; "No" is
            pre-checked because it is the common case and the seeder's own safe
            default, and an unchecked radiogroup is a keyboard trap. */}
        <fieldset className="field bwx-yesno">
          <legend className="metric-lbl">Do you already have a signed contractor?</legend>
          <label className="bwx-radio">
            <input type="radio" name="hasSignedContractor" value="no" defaultChecked />
            <span>No — I&rsquo;ll run a tender first</span>
          </label>
          <label className="bwx-radio">
            <input type="radio" name="hasSignedContractor" value="yes" />
            <span>Yes — skip straight to the build plan</span>
          </label>
        </fieldset>
      </section>
    </ActionForm>
  );
}
