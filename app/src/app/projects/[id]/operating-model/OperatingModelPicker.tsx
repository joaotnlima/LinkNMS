'use client';

// The operating-model choice (M3/D3, LINA-179).
//
// A client component only because it lives inside ActionForm, which owns the
// pending state. The control itself is deliberately as close to plain HTML as it
// gets: three native radios in a fieldset with the card as each one's <label>.
// The alternative — buttons with role="radio" and hand-rolled arrow-key
// handling, which is what onboarding/setup does for its two-way role choice — is
// more code for less behaviour, and this control has three options plus a
// consequence line each, so native arrow-key roving is worth more here.
//
// `defaultChecked` on the first option rather than an empty group: the pen draws
// Turnkey pre-selected (screen 03, "Turnkey selected"), it is the common case,
// and a radiogroup with nothing checked is a keyboard trap-adjacent state where
// Tab enters the group but there is nothing to arrow FROM.
import { ActionForm } from '@/components/ActionForm';
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
    <ActionForm action={setOperatingModelAction} submitLabel="Continue" pendingLabel="Saving…">
      <input type="hidden" name="projectId" value={projectId} />

      <fieldset className="bw-models">
        <legend>How this build is run</legend>
        {OPERATING_MODELS.map((model) => {
          const copy = OPERATING_MODEL_COPY[model];
          return (
            <label className="bw-model" key={model}>
              <input
                type="radio"
                name="operatingModel"
                value={model}
                defaultChecked={model === initial}
              />
              <span className="bw-model-mark" aria-hidden="true" />
              <span className="bw-model-label">{copy.label}</span>
              <span className="bw-model-blurb">{copy.blurb}</span>
              <span className="bw-model-consequence">{copy.consequence}</span>
            </label>
          );
        })}
      </fieldset>
    </ActionForm>
  );
}
