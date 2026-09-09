'use client';

// The "Your role" choice (pen D2, LINA-227, ADR-0016) — the FIRST screen of the
// New-build flow, ahead of Basics.
//
// This screen does NOT create anything: the draft is created at Basics (step 1),
// so the role choice is pure navigation — pick a side, carry it to Basics as
// `?as=`. Hence a plain client component with `router.push`, not an ActionForm:
// there is no server action to run and nothing to persist yet.
//
// The control is two native radios in a fieldset with the card as each one's
// <label>, reusing the operating-model step's `.bwx-model*` classes so selection
// reads the same way across the wizard (border weight + a mark + the native focus
// ring, never colour alone — FR9). Owner is pre-checked: the common case, the
// service default, and a radiogroup with nothing checked is a keyboard trap.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { CREATOR_ROLES, CREATOR_ROLE_COPY, type CreatorRole } from '@/lib/build-creation';

export function RolePicker() {
  const router = useRouter();
  const [role, setRole] = useState<CreatorRole>('owner');

  return (
    <div className="stack">
      <section className="bwx-card">
        <h1 className="bwx-card-title">Who are you on this build?</h1>
        <p className="bwx-card-sub">
          You&rsquo;ll invite the other side in a moment. This just sets what you control and what
          you see. You can hold a different role on every build — this choice only applies here.
        </p>

        <fieldset className="bwx-models">
          <legend className="bwx-sr-only">Your role on this build</legend>
          {CREATOR_ROLES.map((value) => {
            const copy = CREATOR_ROLE_COPY[value];
            return (
              <label className="bwx-model" key={value}>
                <input
                  type="radio"
                  name="creatorRole"
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value)}
                />
                <span className="bwx-model-mark" aria-hidden="true" />
                <span className="bwx-model-label">{copy.label}</span>
                <span className="bwx-model-blurb">{copy.desc}</span>
                <span className="bwx-model-consequence">{copy.tag}</span>
              </label>
            );
          })}
        </fieldset>
      </section>

      <WizardNav back={{ href: '/' }}>
        <button
          type="button"
          className="btn primary"
          onClick={() => router.push(`/projects/new/basics?as=${role}`)}
        >
          {CREATOR_ROLE_COPY[role].continueLabel}
          <ArrowRight />
        </button>
      </WizardNav>
    </div>
  );
}
