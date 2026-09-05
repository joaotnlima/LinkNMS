// The Band B wizard's step indicator (LINA-179), shared by M2/M3/M4 and their
// D variants.
//
// A real ordered list rather than three styled divs, and `aria-current="step"`
// rather than a class, because "where am I and how much is left" is the question
// this control exists to answer and a screen reader user is asked it too. The
// dots are decoration and say so; the sentence below the rail is the actual
// answer, and it is the only form of it that survives on a 360px phone (see the
// `.bw-step-label` note in build-wizard.css).
import { WIZARD_STEPS, TOTAL_STEPS, type WizardStepKey } from '@/lib/build-creation';

export function WizardSteps({ current }: { current: WizardStepKey }) {
  const currentStep = WIZARD_STEPS.find((s) => s.key === current);
  // A step key that is not in the table is a programming error, not a user
  // state; render nothing rather than an indicator that lies about progress.
  if (!currentStep) return null;

  return (
    <div>
      <ol className="bw-steps">
        {WIZARD_STEPS.map((step, i) => {
          const state =
            step.n === currentStep.n ? 'is-current' : step.n < currentStep.n ? 'is-done' : '';
          return (
            <li
              key={step.key}
              className={`bw-step ${state}`.trim()}
              aria-current={step.key === current ? 'step' : undefined}
            >
              <span className="bw-step-dot" aria-hidden="true" />
              <span className="bw-step-label">{step.label}</span>
              {i < WIZARD_STEPS.length - 1 ? (
                <span className="bw-step-rule" aria-hidden="true" />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="bw-steps-caption">
        Step {currentStep.n} of {TOTAL_STEPS} · {currentStep.label}
      </p>
    </div>
  );
}
