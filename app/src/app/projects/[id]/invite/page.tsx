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
import {
  INVITE_ROLE_COPY, OWNER_INVITE_COPY, inviteRoleFor, stepFor, type OperatingModel,
} from '@/lib/build-creation';
import '../../../build-wizard.css';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const build = await getBuild(id);

  // Who may commit this draft (ADR-0016 §3): an ACTIVE build's invites are
  // owner-only (unchanged); a DRAFT is driven by its sole creator — the owner of
  // an owner-created build OR the counterparty of a GC-created one, whose first
  // invite is the missing HOMEOWNER. A draft only ever has one member, so
  // "draft + no owner yet" uniquely identifies a GC creator driving their own
  // draft. The service is the authority; this mirrors it to turn a would-be 403
  // into a sensible screen.
  const hasOwner = build.members.some((m) => m.role === 'owner');
  const inviteOwner = !hasOwner && build.actingRole !== 'owner';
  const canDrive = build.actingRole === 'owner' || (build.status === 'draft' && inviteOwner);
  if (!canDrive) redirect(`/projects/${id}`);

  // A draft with no operating model cannot be invited against — the service 409s
  // rather than committing a build whose model was never chosen. Send them to the
  // step they actually owe rather than rendering a form that is guaranteed to
  // fail on submit.
  if (stepFor(build) === 'model') redirect(`/projects/${id}/operating-model`);

  const operatingModel = (build.operatingModel ?? null) as OperatingModel | null;
  // The role this build's first invite creates. Normally the operating model
  // decides it; a GC-created build inverts it to the homeowner (ADR-0016 §4).
  const role = inviteOwner ? 'owner' : inviteRoleFor(operatingModel);
  const copy = inviteOwner ? OWNER_INVITE_COPY : INVITE_ROLE_COPY[inviteRoleFor(operatingModel)];

  // V1 invites one party per wizard pass (ADR-0011 OQ-3), so a build that already
  // has this role filled has nothing to do here.
  const joined = build.members.find((m) => m.role === role);
  const isDraft = build.status === 'draft';

  return (
    <WizardChrome>
      <WizardSteps current="invite" />

      {joined ? (
        <section className="bwx-card">
          <h1 className="bwx-card-title">Invite the {copy.noun}</h1>
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
          inviteOwner={inviteOwner}
          copy={copy}
        />
      )}
    </WizardChrome>
  );
}
