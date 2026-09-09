// M4/D4 — "Invite", step 3 of Band B (LINA-179; pen-rebuilt chrome LINA-219;
// originally LINA-57 / LINA-84).
//
// Pen source: the "New build" flow, screen "Invite (3 of 3)".
//
// THIS IS THE STEP THAT COMMITS THE BUILD. The first invite flips a draft to
// `active` and writes a `project_committed` ledger event in the same unit of work
// (ADR-0011 decision 2), so the screen says what is about to become shared rather
// than presenting the invite as a small last formality.
//
// PEN FIELDS NOT YET DRAWN (LINA-219, deferred to their own slice). The pen's
// Invite screen adds an invitee "Name or company" field, a Role picker and a
// "Scope note" textarea. `identity.invitation` stores none of these (it is email
// + a model-derived role), so rendering them would discard what the owner types —
// the one thing this codebase refuses to do (see the GAPS note in
// @/lib/build-creation). This step ships the new chrome with the shipped
// email-only field; the new fields land with the columns that back them.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { WizardChrome } from '@/components/WizardChrome';
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
    <WizardChrome>
      <WizardSteps current="invite" />

      {joined ? (
        <section className="bwx-card">
          <h1 className="bwx-card-title">Invite your {copy.noun}</h1>
          <p className="bwx-card-sub">
            <strong>{joined.displayName?.trim() || 'Someone'}</strong> has already joined this build
            as the {copy.noun}.
          </p>
          <Link className="btn primary" href={`/projects/${id}`}>
            Go to the build
          </Link>
        </section>
      ) : (
        <InvitePanel
          projectId={id}
          operatingModel={operatingModel}
          buildName={build.name}
          isDraft={isDraft}
        />
      )}
    </WizardChrome>
  );
}
