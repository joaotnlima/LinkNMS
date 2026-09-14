// Phase lifecycle service — constructor selection & procurement skip (LINA-280;
// ADR-0023 §3; slice-procurement-contract §1 routes 7-8).
//
// The two transitions are the moment the procurement layer hands the build to
// the constructor:
//
//   selectConstructor — `POST /projects/:id/procurement/proposals/:proposalId:select`
//                       Award the winning bid: procurement phase → signed_off,
//                       execution → active, rfp.status → closed, and the awarded
//                       bidder is onboarded as a `subcontractor` member (Band B
//                       read-only). The RFP token expiry is the DYNAMIC join
//                       (ADR-0023 §5 Option A): the instant procurement flips to
//                       signed_off the recipient-token reads stop resolving — no
//                       stored expiry to clean up.
//
//   skipProcurement   — `POST /projects/:id/procurement:skip`
//                       Persona B — the owner who already has a signed
//                       contractor never runs an RFP. Same status flips, no
//                       proposal, no onboarding (the contractor is already a
//                       project member), no selected proposal.
//
// Both are gated by ACTION.SELECT_CONSTRUCTOR (owner + counterparty). The phase
// status flips + rfp close commit in ONE schedule-store transaction; the member
// onboarding commits through the identity service (its own unit of work, per the
// no-cross-schema-transaction rule of the service boundaries — ADR-0006 §1).
// Onboarding happens FIRST in the award path so a dead membership insert aborts
// the whole call before any phase is flipped.
//
// Both return the full `ProcurementView` (slice-procurement-contract §2) — a
// selection changes more than it names, and a partial response would leave the
// consumer painting a state that no longer exists.

import { ACTION } from './ports.mjs';
import { DomainError } from './ports.mjs';

const CODES = Object.freeze({
  notFound: 'not_found',
  notMember: 'not_member',
  phaseNotActive: 'phase_not_active',
  phaseMismatch: 'phase_mismatch',
  proposalNotFound: 'proposal_not_found',
  contractorNotSeated: 'contractor_not_seated',
  rfpAlreadySent: 'rfp_already_sent',
  alreadySelected: 'already_selected',
});

export function createPhaseService({ store, identity }) {
  if (!store || !identity) {
    throw new Error('createPhaseService requires { store, identity } ports');
  }

  // Contract §0.1: the actor is the session, never the body. Not-a-member is the
  // `not_member` code the FE reads; the capability check below then answers
  // whether THIS member may run the action.
  async function requireSelectCapability(actorPartyId, projectId) {
    if (!actorPartyId) {
      throw new DomainError(401, 'unauthenticated', 'you must be signed in to do that');
    }
    const role = await identity.roleOf(projectId, actorPartyId);
    if (!role) {
      throw new DomainError(403, CODES.notMember, 'you are not on this build, so you cannot run its procurement');
    }
    await identity.authorize({ actorPartyId, action: ACTION.SELECT_CONSTRUCTOR, projectId });
  }

  // The pre-flight face check (outside any tx) so a spent / never-started
  // procurement aborts with zero side effects — no zombie membership for an
  // award that cannot land. Returns the procurement phase row.
  function checkProcurementWindow(procurement, rfp) {
    if (!procurement) throw new DomainError(404, CODES.notFound, 'this project has no procurement phase');
    if (procurement.status === 'signed_off') throw alreadySelected();
    if (procurement.status !== 'active') {
      throw new DomainError(409, CODES.phaseNotActive, 'procurement is not open on this build');
    }
    if (rfp) {
      if (rfp.status === 'closed') throw alreadySelected();
      if (rfp.status !== 'sent') {
        throw new DomainError(409, CODES.phaseNotActive, 'the procurement window is not open');
      }
    }
    return procurement;
  }

  const alreadySelected = () =>
    new DomainError(409, CODES.alreadySelected, 'a constructor has already been selected for this build');

  // The shared flip: sign procurement off, activate execution. Runs on the
  // caller's tx, with the phases re-read under a ROW LOCK so the guard and a
  // concurrent select-constructor serialise (the signed_off trigger is the last
  // line of defence).
  async function flipToExecution(tx, { procurement, projectId }) {
    const locked = await store.getPhaseById(procurement.id, tx);
    if (!locked) throw new DomainError(404, CODES.notFound, 'procurement phase not found');
    if (locked.status === 'signed_off') throw alreadySelected();
    if (locked.status !== 'active') {
      throw new DomainError(409, CODES.phaseNotActive, 'procurement is not open on this build');
    }

    const signedOff = await store.updatePhaseStatus(tx, locked.id, 'signed_off');
    const execution = await store.getExecutionPhase(projectId, tx);
    let active = null;
    if (execution && execution.status !== 'active') {
      active = await store.updatePhaseStatus(tx, execution.id, 'active');
    } else {
      active = execution; // already active or absent (absent = pre-LINA-278 data)
    }
    return { signedOff, execution: active };
  }

  // POST /projects/:id/procurement/proposals/:proposalId:select
  async function selectConstructor({ actorPartyId, projectId, proposalId }) {
    await requireSelectCapability(actorPartyId, projectId);

    const proposal = await store.getProposalById(proposalId);
    if (!proposal) throw new DomainError(404, CODES.proposalNotFound, 'proposal not found');
    if (proposal.project_id !== projectId) {
      throw new DomainError(409, CODES.phaseMismatch, 'the proposal does not belong to this project');
    }

    const rfp = await store.getRfpById(proposal.rfp_id);
    const procurement = await store.getPhaseById(proposal.phase_id);
    checkProcurementWindow(procurement, rfp);

    // The awardee must already sit on the platform as a party — we do NOT
    // materialise a zombie party for an email that has never signed in (Q3).
    const partyId = await identity.resolvePartyIdByEmail(proposal.recipient_email);
    if (!partyId) {
      throw new DomainError(
        422,
        CODES.contractorNotSeated,
        'the awarded contractor has no account on the platform yet — invite them first',
      );
    }

    // Member write FIRST (identity's own unit of work): an already-seated
    // subcontractor passes (the award's requirement is met), a non-member is
    // onboarded, and a party that chairs the project in another role is a clean
    // conflict. A failed onboarding aborts before any phase status has moved.
    const existingRole = await identity.roleOf(projectId, partyId);
    if (existingRole === 'subcontractor') {
      // already seated — nothing to write
    } else if (!existingRole) {
      await identity.onboardProjectMember({
        actorPartyId, projectId, partyId, role: 'subcontractor',
      });
    } else {
      throw new DomainError(
        409,
        'conflict',
        'the awarded contractor is already a member of this project in another role',
      );
    }

    await store.transaction(async (tx) => {
      await flipToExecution(tx, { procurement, projectId });
      // The rfp close + the winner marker are ONE guarded UPDATE (an rfp that is
      // `signed_off`'d procurement can never re-open; the close IS the award).
      await store.closeRfp(tx, rfp.id, proposalId);
    });

    return readProcurementView(projectId);
  }

  // POST /projects/:id/procurement:skip
  async function skipProcurement({ actorPartyId, projectId }) {
    await requireSelectCapability(actorPartyId, projectId);

    const procurement = await store.getProcurementPhase(projectId);
    const rfp = await store.getRfpByPhase(procurement?.id ?? '');
    if (procurement && procurement.status === 'signed_off') throw alreadySelected();
    if (procurement && procurement.status !== 'active') {
      throw new DomainError(409, CODES.phaseNotActive, 'procurement is not open on this build');
    }
    if (rfp) {
      if (rfp.status === 'closed') throw alreadySelected();
      // Contract §5: skipping after tokens are out would kill live invitations
      // with no warning — once sent, the way forward is selecting a proposal.
      if (rfp.status === 'sent') {
        throw new DomainError(409, CODES.rfpAlreadySent, 'this RFP has already gone out — you must select a proposal');
      }
    }
    if (!procurement) throw new DomainError(404, CODES.notFound, 'this project has no procurement phase');

    await store.transaction(async (tx) => {
      await flipToExecution(tx, { procurement, projectId });
      // A stale `draft` rfp is closed without a winner — its tokens were never
      // minted, so nothing outstanding dies.
      if (rfp && rfp.status === 'draft') await store.closeRfp(tx, rfp.id, null);
    });

    return readProcurementView(projectId);
  }

  // The full ProcurementView (slice-procurement-contract §2) — one read for the
  // whole accordion section. rfp stays readable after it closes: the losers and
  // the winner are the permanent record of the choice.
  async function readProcurementView(projectId) {
    const procurement = await store.getProcurementPhase(projectId);
    if (!procurement) throw new DomainError(404, CODES.notFound, 'this project has no procurement phase');
    const rfp = await store.getRfpByPhase(procurement.id);
    const recipients = rfp ? await store.listRecipientsByRfp(rfp.id) : [];
    const proposals = rfp ? await store.listProposalsByRfp(rfp.id) : [];

    return {
      phase: {
        id: procurement.id,
        kind: procurement.kind,
        name: procurement.name,
        status: procurement.status,
        sequence: procurement.sequence,
      },
      rfp: rfp
        ? {
            id: rfp.id,
            phaseId: rfp.phase_id,
            description: rfp.description,
            attachments: (rfp.attachments ?? []).map(mapFileRef),
            specialties: rfp.specialties ?? [],
            status: rfp.status,
            updatedAt: rfp.updated_at,
          }
        : null,
      recipients: recipients.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        rfpRecipientId: p.rfp_recipient_id,
        companyName: p.company_name,
        websiteUrl: p.website_url ?? null,
        portfolioImages: (p.portfolio_images ?? []).map(mapFileRef),
        budgetMinCents: p.budget_min_cents == null ? null : Number(p.budget_min_cents),
        budgetMaxCents: p.budget_max_cents == null ? null : Number(p.budget_max_cents),
        timelineDays: p.timeline_days == null ? null : Number(p.timeline_days),
        comment: p.comment ?? null,
        submittedAt: p.submitted_at,
      })),
      selectedProposalId: rfp?.selected_proposal_id ?? null,
    };
  }

  return { selectConstructor, skipProcurement };
}

// An R2 ref as the wire shape names it (§2 FileRef) — DB rows store
// `content_type`, the contract says `contentType`.
function mapFileRef(ref) {
  if (!ref || typeof ref !== 'object') return ref;
  return {
    key: ref.key,
    filename: ref.filename,
    size: ref.size,
    contentType: ref.content_type ?? ref.contentType,
    url: ref.url,
  };
}