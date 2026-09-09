// The Band B wizard's step indicator (LINA-179; pen-rebuilt LINA-219).
//
// The new pen draws a numbered rail: filled navy badges carrying the step number,
// a check-mark once a step is done, hollow badges ahead, joined by a rule and
// centred above the card. That replaces the earlier row of dots.
//
// A real ordered list rather than three styled divs, and `aria-current="step"`
// rather than a class, because "where am I and how much is left" is the question
// this control exists to answer and a screen reader user is asked it too. The
// badges are decoration and say so; the sentence below the rail is the actual
// answer, and it is the only form of it that survives on a 360px phone (see the
// `.bwx-step-label` note in build-wizard.css).
import { Check } from '@/components/icons';
import { WIZARD_STEPS, TOTAL_STEPS, type WizardStepKey } from '@/lib/build-creation';

export function WizardSteps({ current }: { current: WizardStepKey }) {
  const currentStep = WIZARD_STEPS.find((s) => s.key === current);
  // A step key that is not in the table is a programming error, not a user
  // state; render nothing rather than an indicator that lies about progress.
  if (!currentStep) return null;

  return (
    <div className="bwx-steps-wrap">
      <ol className="bwx-steps">
        {WIZARD_STEPS.map((step, i) => {
          const done = step.n < currentStep.n;
          const state = step.n === currentStep.n ? 'is-current' : done ? 'is-done' : '';
          return (
            <li
              key={step.key}
              className={`bwx-step ${state}`.trim()}
              aria-current={step.key === current ? 'step' : undefined}
            >
              <span className="bwx-step-badge" aria-hidden="true">
                {done ? <Check className="bwx-step-check" /> : step.n}
              </span>
              <span className="bwx-step-label">{step.label}</span>
              {i < WIZARD_STEPS.length - 1 ? (
                <span className="bwx-step-rule" aria-hidden="true" />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="bwx-steps-caption">
        Step {currentStep.n} of {TOTAL_STEPS} · {currentStep.label}
      </p>
    </div>
  );
}
