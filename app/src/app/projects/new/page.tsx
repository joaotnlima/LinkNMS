// D2 — "New build · Your role", the FIRST screen of the New-build flow
// (LINA-227, ADR-0016). It sits AHEAD of Basics and asks which side of the table
// the creator is on for this build: General contractor or Owner.
//
// Pen source: cowork/pen/linkNMS.pen → 'Band B · Create the build and invite' →
// 'S · D2 · New build · Your role'.
//
// It is a PRE-WIZARD question, not a counted step, so it renders no step rail —
// the three-step Basics/Model/Invite rail is unchanged and an owner's flow past
// this screen is byte-identical to before (ADR-0016 §2). The choice is carried to
// Basics as `?as=owner|counterparty`; nothing is created here (the draft is
// created at Basics), so the picker is pure navigation — see RolePicker.
//
// `/projects/new` is the wizard's entry (the portfolio "New build" CTA), so this
// is where the flow begins; Basics moved to `/projects/new/basics`.
import { redirect } from 'next/navigation';
import { WizardChrome } from '@/components/WizardChrome';
import { RolePicker } from './RolePicker';
import { isSignedIn } from '@/lib/api';
import '../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function NewBuildRolePage() {
  if (!(await isSignedIn())) redirect('/sign-in?next=/projects/new');

  return (
    <WizardChrome>
      <RolePicker />
    </WizardChrome>
  );
}
