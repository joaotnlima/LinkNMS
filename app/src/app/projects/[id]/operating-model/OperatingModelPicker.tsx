'use client';

// The operating-model choice (M3/D3, LINA-179; pen-rebuilt LINA-219).
//
// A client component only because it lives inside ActionForm, which owns the
// pending state. The control itself is deliberately as close to plain HTML as it
// gets: three native radios in a fieldset with the card as each one's <label>.
// The alternative — buttons with role="radio" and hand-rolled arrow-key
// handling — is more code for less behaviour, and native arrow-key roving is
// worth more here with three options plus a consequence line each.
//
// `defaultChecked` on the first option rather than an empty group: the pen draws
// Turnkey pre-selected, it is the common case, and a radiogroup with nothing
// checked is a keyboard trap-adjacent state where Tab enters the group but there
// is nothing to arrow FROM.
//
// PEN LAYOUT (LINA-219): the title and sub-copy sit INSIDE the card above the
// options, and the Back / Continue controls sit BELOW the card via WizardNav.
import { ActionForm } from '@/components/ActionForm';
import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { setOperatingModelAction } from '@/app/actions';
import { OPERATING_MODELS, OPERATING_MODEL_COPY, type OperatingModel } from '@/lib/build-creation';

export function OperatingModelPicker({
  projectId,
  selected,
}: {
  projectId: string;
  /** The model already on the build, when the owner is resuming or stepping
   *  back. Null on a fresh draft. */
  selected: OperatingModel | null;
}) {
  const initial = selected ?? OPERATING_MODELS[0];

  return (
    <ActionForm
      action={setOperatingModelAction}
      submitLabel="Continue"
      pendingLabel="Saving…"
      footer={({ pending }) => (
        <WizardNav back={{ href: '/projects/new' }}>
          <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
            {pending ? 'Saving…' : 'Continue'}
            <ArrowRight />
          </button>
        </WizardNav>
      )}
    >
      <input type="hidden" name="projectId" value={projectId} />

      <section className="bwx-card">
        <h1 className="bwx-card-title">How is this build contracted?</h1>
        <p className="bwx-card-sub">
          This shapes who you invite and who fills in the plan. You will not be asked again.
        </p>

        <fieldset className="bwx-models">
          <legend className="bwx-sr-only">How this build is run</legend>
          {OPERATING_MODELS.map((model) => {
            const copy = OPERATING_MODEL_COPY[model];
            return (
              <label className="bwx-model" key={model}>
                <input
                  type="radio"
                  name="operatingModel"
                  value={model}
                  defaultChecked={model === initial}
                />
                <span className="bwx-model-mark" aria-hidden="true" />
                <span className="bwx-model-label">{copy.label}</span>
                <span className="bwx-model-blurb">{copy.blurb}</span>
                <span className="bwx-model-consequence">{copy.consequence}</span>
              </label>
            );
          })}
        </fieldset>
      </section>
    </ActionForm>
  );
}
