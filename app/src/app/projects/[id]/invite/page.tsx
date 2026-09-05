// M4/D4 — "Invite", step 3 of Band B (LINA-179; originally LINA-57 / LINA-84).
//
// Pen source: Bootstrap Flow Board, screen 04 ("Invite General Contractor") and
// screen 05 ("Invite sent"), the second of which is the result state rendered by
// InvitePanel without a navigation.
//
// THIS IS THE STEP THAT COMMITS THE BUILD. The first invite flips a draft to
// `active` and writes a `project_committed` ledger event in the same unit of work
// (ADR-0011 decision 2), so the screen says what is about to become shared rather
// than presenting the invite as a small last formality.
//
// One pen field is absent: the "Scope note" textarea on screen 04.
// `identity.invitation` has no note column (migration 0009 added none), so it
// would be a textarea whose contents the server discards — see the GAPS note in
// @/lib/build-creation. A scope note also belongs on the record as a decision,
// not on an invitation that is consumed and gone.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { TopBar } from '@/components/chrome';
import { WizardSteps } from '@/components/WizardSteps';
import { InvitePanel } from './InvitePanel';
import { getBuild } from '@/lib/api';
import { INVITE_ROLE_COPY, inviteRoleFor, stepFor, type OperatingModel } from '@/lib/build-creation';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const build = await getBuild(id);

  // Owner-only. The service enforces this too (it is the authority); checking
  // here as well is what turns a would-be 403 into a sensible screen.
  if (build.actingRole !== 'owner') redirect(`/projects/${id}`);

  // A draft with no operating model cannot be invited against — the service 409s
  // rather than committing a build whose model was never chosen. Send them to the
  // step they actually owe rather than rendering a form that is guaranteed to
  // fail on submit.
  if (stepFor(build) === 'model') redirect(`/projects/${id}/operating-model`);

  const operatingModel = (build.operatingModel ?? null) as OperatingModel | null;
  const role = inviteRoleFor(operatingModel);
  const copy = INVITE_ROLE_COPY[role];

  // V1 invites one party per wizard pass (ADR-0011 OQ-3), so a build that already
  // has this role filled has nothing to do here.
  const joined = build.members.find((m) => m.role === role);
  const isDraft = build.status === 'draft';

  return (
    <>
      <TopBar back={{ href: `/projects/${id}`, label: build.name }} />
      <main className="bw">
        <WizardSteps current="invite" />

        <div className="bw-head">
          <div className="crumbs">{build.name}</div>
          <h1 className="bw-title">Invite your {copy.noun}</h1>
          <p className="bw-lede">
            {isDraft
              ? `This is the step that opens the build. The moment you send it, ${build.name} becomes a shared record — everything either of you writes on it from then on is attributed and time-stamped.`
              : `They join the shared record for ${build.name}. Everything either of you writes on it is attributed and time-stamped.`}
          </p>
        </div>

        {joined ? (
          <section className="bw-card">
            <p>
              <strong>{joined.displayName?.trim() || 'Someone'}</strong> has already joined this
              build as the {copy.noun}.
            </p>
            <Link className="btn" href={`/projects/${id}`}>
              Go to the build
            </Link>
          </section>
        ) : (
          <section className="bw-card">
            <InvitePanel projectId={id} operatingModel={operatingModel} />
          </section>
        )}
      </main>
    </>
  );
}
