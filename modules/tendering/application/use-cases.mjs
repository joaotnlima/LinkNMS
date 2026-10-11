// Tendering module use cases (phase 6) — one function per operationId:
//   createRfp, getRfp, updateRfp, addRecipients, previewInviteEmail, listRecipients, publishRfp,
//   addAddendum, closeRfp, cancelRfp, browseOpenRfps, listMyRfps,
//   askClarification(+ByToken), answerClarification, listProposalLanes, getProposal,
//   putProposal, submitProposal, withdrawProposal, recordOfflineProposal,
//   getComparison, shortlistProposal, awardRfp.
// PRD-04 (D-47): applyToOpenRfp (now ask to bid) and the bid-request decisions
// live in ./bid-requests.mjs, the company inbox in ./company-inbox.mjs.
//
// Authorization is the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship ∧ staffing.
// Relationships (openapi x-relationship, docs 04/06):
//   issuer      — the org that created the RFP;
//   recipient   — an org invited on it (or holding a lane);
//   author      — the bidder org of a proposal (its lane, V8);
//   edit scope ∋ roots — createRfp: project owner at owner level, supplier
//                 of the live contract whose branch holds every root at sub
//                 level (R1); the level is DERIVED from this, never posted.
// publishRfp and awardRfp are x-human-only (doc 19): the MCP channel is
// answered forbidden{reason:'human_only'} before anything else.
// Entitlements (rfp.publish, rfp.open_listing, proposal.submit_open) are the
// billing module's port — phase 8; not enforced yet, documented in CHANGELOG.
//
// The store owns transactions AND writes ledger + outbox inside them
// (invariants §6.3/§6.4); a use case never half-commits. Proposal-scoped
// entries carry scope rfp_private (V7/V8).
import { randomUUID } from 'node:crypto';

import { awardedPlanFacts } from '../domain/award.mjs';
import { ProblemError } from '../../../platform/errors.mjs';
import { visibilityOf, contractBody } from '../../contracting/domain/lifecycle.mjs';
import { rfpTransition, proposalTransition } from '../domain/lifecycle.mjs';
import {
  rfpBody, packageBody, recipientBody, clarificationBody, laneBody, proposalBody, rfpLinkView,
  rfpWindowBody,
} from '../domain/wire.mjs';
import { comparisonMatrix, missingLineCount } from '../domain/comparison.mjs';
import { exclusionError, prunePackage } from '../domain/package-scope.mjs';
import { questionsOpen, visibleClarifications } from '../domain/clarifications.mjs';
import { renderInviteEmail, PREVIEW_LINK_PLACEHOLDER_TOKEN } from '../domain/invite-email.mjs';
import {
  validateAttachmentFile, attachmentStorageKey, uploadTicketBody, attachmentBody,
  MAX_ATTACHMENTS_PER_PROPOSAL,
} from '../domain/attachment.mjs';
import { validateModelFile, modelBody, MODEL_MIME } from '../domain/rfp-model.mjs';
import { defaultSubmissionDeadline } from '../domain/deadlines.mjs';
// Pure key-shape helper owned by the Documents domain — the BIM model is a
// Documents-module document (doc 24 decision 2); tendering owns its auth and
// delegates persistence to the injected documents store, so it builds the same
// storage key the Documents use-cases do. Importing a PURE function (no I/O)
// across modules keeps the two key-shapes identical and greppable.
import { storageKey as documentStorageKey } from '../../documents/domain/model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES = new Set(['invite_only', 'open']);
const PURPOSES = new Set(['design', 'execution']);
const MODES = new Set(['light', 'detailed']);
const ANCHORS = new Set(['start', 'end']);
const ROW_KINDS = new Set(['task', 'summary', 'milestone']);

// ── RFP lifecycle (issuer side) ─────────────────────────────────────────────

/** operationId: createRfp — package = subtrees + docs + quantities, no prices. */
export async function createRfp({ viewer, store, projectId, body, idempotencyKey, now = new Date() }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { project } = await requireParticipant({ viewer, store, projectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (typeof body?.title !== 'string' || !body.title.trim()) errors.title = 'required';
  const roots = body?.root_task_ids;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
    errors.root_task_ids = 'a non-empty list of task ids';
  }
  if (body?.visibility !== undefined && !VISIBILITIES.has(body.visibility)) {
    errors.visibility = 'invite_only or open';
  }
  if (body?.listed !== undefined && typeof body.listed !== 'boolean') errors.listed = 'true or false';
  // Purpose / mode (D-39): design is always light (prices a service, no BoQ),
  // execution defaults to detailed (the as-is). An explicit mode is honoured
  // but may not contradict the design⇒light invariant the DB also pins.
  const purpose = body?.purpose ?? 'execution';
  if (!PURPOSES.has(purpose)) errors.purpose = 'design or execution';
  const mode = body?.mode ?? (purpose === 'design' ? 'light' : 'detailed');
  if (!MODES.has(mode)) errors.mode = 'light or detailed';
  else if (purpose === 'design' && mode !== 'light') errors.mode = 'a design RFP is always light';
  // Omitted bids-due → the server's default (domain/deadlines.mjs), never the client's.
  const submissionDeadline = body?.submission_deadline ?? defaultSubmissionDeadline(now);
  validateDeadlines({ ...body, submission_deadline: submissionDeadline }, errors, { submissionRequired: true });
  validateExclusions(body, errors);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const uniqueRoots = [...new Set(roots)];
  const known = await store.tasksOfProject(projectId, uniqueRoots);
  const missing = uniqueRoots.filter((t) => !known.has(t));
  if (missing.length) {
    throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
  }

  // Relationship: edit scope ∋ roots — and the LEVEL follows from it (D-35):
  // the owner tenders at owner level; a supplier tenders INSIDE its own live
  // branch (R1) and nowhere else.
  let level = null;
  let parentContractId = null;
  if (project.owner_org_id === viewer.orgId) {
    level = 'owner';
  } else {
    const branches = await store.branchContractsOf(uniqueRoots);
    const distinct = [...new Set(branches.map((b) => b.branch_contract_id ?? null))];
    if (distinct.length !== 1 || !distinct[0]) {
      throw new ProblemError('forbidden', 'the tendered rows are not inside one contract branch of yours', { reason: 'relationship' });
    }
    const contract = await store.getContract(distinct[0]);
    if (!contract || contract.supplier_org_id !== viewer.orgId
        || !['signed', 'active'].includes(contract.status)) {
      throw new ProblemError('forbidden', 'only the supplier of the live contract over these rows tenders inside it', { reason: 'relationship' });
    }
    level = 'sub';
    parentContractId = contract.id;
  }

  const excluded = [...new Set(body?.excluded_task_ids ?? [])];
  const snapshot = scopedSnapshot(await store.snapshotPackage(projectId, uniqueRoots), excluded);
  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createRfp', body }, async () => {
    const created = await store.createRfp({
      id: body.id,
      projectId,
      issuerOrgId: viewer.orgId,
      level,
      parentContractId,
      purpose,
      mode,
      title: body.title.trim(),
      scopeText: body.scope_text ?? null,
      listed: listedOf(body) ?? false,
      questionsDeadline: body.questions_deadline ?? null,
      submissionDeadline,
      rootTaskIds: uniqueRoots,
      excludedTaskIds: excluded,
      packageRows: snapshot.rows,
      packageItems: snapshot.items,
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: rfpBody(created) };
  });
}

/** operationId: getRfp — issuer: full; recipient: package + clarifications. */
export async function getRfp({ viewer, store, documentsStore, rfpId }) {
  const { rfp, isIssuer } = await requireRfpRead({ viewer, store, rfpId });
  const pkg = await store.packageOf(rfpId, rfp.package_version);
  // The asker is anonymised for everyone (V8); bidders additionally only see
  // what was PUBLISHED to all of them — answered questions and their own.
  const clarifications = visibleClarifications(await store.clarificationsOf(rfpId), {
    isIssuer, asker: { orgId: viewer.orgId },
  }).map(({ row, mine }) => clarificationBody(row, { mine }));
  const models = await loadRfpModels(documentsStore, rfp);
  return {
    status: 200,
    body: {
      ...rfpBody(rfp),
      package: packageBody(pkg.rows, pkg.items, models),
      clarifications,
      questions_open: questionsOpen(rfp),
    },
  };
}

// ── Public personal link (gap S1, security: []) ─────────────────────────────
// The RFP personal link is the one anonymous surface in tendering: the caller
// holds a 32-byte token and NOTHING else — no session, no viewer. So these two
// use cases take no `viewer`; the token IS the authority. Three rules run
// through both (doc 21 S1, mirroring the as-is LINA-284/294):
//   1. A refusal never leaks whether the token exists — unknown, revoked and
//      expired tokens all answer a uniform not_found (the store returns null
//      for all three), so the endpoint is not an existence oracle.
//   2. The projection is narrow (rfpLinkView): the package to price, the
//      project name/locality, the invited email, and the bidder's OWN proposal.
//      Never the issuer, the other recipients, or another lane (V8).
//   3. The link is single-use for submission: the auto-created proposal starts
//      'invited'; the submit moves it to 'submitted' and is guarded on that, so
//      a second POST answers already_submitted and the GET afterwards returns
//      the confirmation view (the proposal echoed back) instead of the form.

/** operationId: getRfpByToken — GET /rfp-links/{token}, security: []. */
export async function getRfpByToken({ store, documentsStore, token }) {
  const rec = await store.findRecipientByToken(token ?? '');
  if (!rec) throw new ProblemError('not_found', 'this link is not valid');
  // A best-effort delivery breadcrumb; never blocks the read.
  await store.markRecipientOpened(rec.id).catch(() => {});
  const pkg = await store.packageOf(rec.rfp_id, rec.package_version);
  const proposal = await loadOwnProposalEcho(store, rec.proposal_id);
  const models = await loadRfpModels(documentsStore, rec);
  const rfp = {
    title: rec.title, scope_text: rec.scope_text, specialties: rec.specialties,
    purpose: rec.purpose, mode: rec.mode, questions_deadline: rec.questions_deadline,
    submission_deadline: rec.submission_deadline, status: rec.rfp_status,
  };
  // PRD-08 H-6..H-8: answered questions (public to every bidder) + this
  // recipient's own, asker never named; and whether it may still ask.
  const clarifications = visibleClarifications(await store.clarificationsOf(rec.rfp_id), {
    asker: { orgId: rec.org_id ?? null, recipientId: rec.id },
  }).map(({ row, mine }) => clarificationBody(row, { mine }));
  return {
    status: 200,
    body: rfpLinkView(rfp, {
      pkg, project: { name: rec.project_name, location: rec.project_location },
      recipientEmail: rec.email, proposal, models,
      questionsOpen: questionsOpen(rfp), clarifications,
    }),
  };
}

/**
 * Validate a SUMMARY bid body — one total, a working-day duration, optional
 * conditions/validity, and portfolio document ids. The single authority behind
 * both the public-token submit (submitProposalByToken) and the authenticated
 * self-serve submit (submitOwnBid), so the two simple-bid paths can never drift.
 *
 * The document-id check is async: each id must be a `stored` proposal_document
 * of THIS proposal — a well-formed UUID that names someone else's file, or a
 * ticket never completed, is refused here so a submit cannot smuggle a reference
 * the download side would reject. Returns the field errors (empty when valid)
 * and the de-duped document ids.
 */
async function validateSummaryBid({ store, proposalId, body }) {
  const errors = {};
  if (!Number.isInteger(body?.total?.amount_cents) || body.total.amount_cents < 0) {
    errors.total = 'Money {amount_cents, currency}';
  } else if (body.total.currency !== 'EUR') errors.total = 'currency must be EUR';
  if (!Number.isInteger(body?.duration_wd) || body.duration_wd <= 0) {
    errors.duration_wd = 'working days > 0';
  }
  const docs = body?.document_ids ?? [];
  if (!Array.isArray(docs) || docs.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'document ids';
  } else if (docs.length) {
    const stored = await store.storedProposalDocumentIds(proposalId);
    if (docs.some((d) => !stored.has(d))) {
      errors.document_ids = 'each id must be a completed upload on this proposal';
    }
  }
  if (body?.validity_until !== undefined && body?.validity_until !== null
      && !DATE_ONLY.test(body.validity_until)) errors.validity_until = 'YYYY-MM-DD';
  // Light-bid references (D-39): optional free text, capped so a single field
  // can't be used to stuff the lane. Trimmed to null when blank.
  let referenceNotes = body?.reference_notes;
  if (referenceNotes !== undefined && referenceNotes !== null) {
    if (typeof referenceNotes !== 'string') errors.reference_notes = 'text';
    else {
      referenceNotes = referenceNotes.trim() || null;
      if (referenceNotes && referenceNotes.length > 4000) errors.reference_notes = '4000 chars max';
    }
  } else referenceNotes = null;
  return { errors, docs: Array.isArray(docs) ? [...new Set(docs)] : [], referenceNotes };
}

/** operationId: submitProposalByToken — POST /rfp-links/{token}/proposal, security: []. */
export async function submitProposalByToken({ store, token, body }) {
  const rec = await store.findRecipientByToken(token ?? '');
  if (!rec) throw new ProblemError('not_found', 'this link is not valid');
  const proposal = await store.getProposal(rec.proposal_id);
  // Single-use: only a fresh lane accepts a bid; anything else is spent. The v2
  // vocabulary (doc 11) has no `already_submitted` code — a spent link is a
  // state-machine refusal, so it is invalid_transition (the GET's `closed` and
  // echoed `proposal` are what the form reads to render the confirmation view).
  if (!proposal || !['invited', 'draft'].includes(proposal.status)) {
    throw new ProblemError('invalid_transition', 'a proposal has already been sent for this link');
  }
  // The window can close between the page load and the submit — refuse rather
  // than land a bid nobody will read (the as-is checked this on POST too).
  if (rec.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'this RFP is no longer accepting proposals');
  }

  const { errors, docs, referenceNotes } = await validateSummaryBid({ store, proposalId: proposal.id, body });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const updated = await store.submitPublicProposal({
    proposalId: proposal.id,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: body.total.amount_cents,
    durationWd: body.duration_wd,
    conditions: body.conditions ?? null,
    validityUntil: body.validity_until ?? null,
    referenceNotes,
    documentIds: docs,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    recipientOrgId: rec.org_id ?? null,
  });
  if (!updated) throw new ProblemError('invalid_transition', 'a proposal has already been sent for this link');
  const doc = await store.proposalDoc(updated.id);
  // The bidder always sees the money on their own proposal.
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: true }) };
}

/** The recipient's own proposal, echoed once it has left the invited state. */
async function loadOwnProposalEcho(store, proposalId) {
  if (!proposalId) return null;
  const row = await store.getProposal(proposalId);
  if (!row || row.status === 'invited') return null;
  const doc = await store.proposalDoc(proposalId);
  return { row, doc };
}

/**
 * The token → live proposal guard the public upload steps share with the
 * submit: the token must resolve, its proposal must still be open to a bid
 * (`invited`/`draft`), and the RFP must still be `published`. A spent or closed
 * link cannot grow new attachments — same refusal vocabulary as the submit,
 * same uniform not_found for an unknown token (no existence oracle).
 */
async function resolveLiveTokenProposal(store, token) {
  const rec = await store.findRecipientByToken(token ?? '');
  if (!rec) throw new ProblemError('not_found', 'this link is not valid');
  const proposal = await store.getProposal(rec.proposal_id);
  if (!proposal || !['invited', 'draft'].includes(proposal.status)) {
    throw new ProblemError('invalid_transition', 'a proposal has already been sent for this link');
  }
  if (rec.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'this RFP is no longer accepting proposals');
  }
  return { rec, proposal };
}

/**
 * operationId: reserveProposalDocumentByToken —
 * POST /rfp-links/{token}/documents, security: [].
 *
 * The tokened bidder's portfolio-image upload (LINA-370): reserve a `pending`
 * attachment row and answer a presigned PUT whose signature pins the declared
 * sha256, so R2 itself refuses any bytes but the ones declared. The client PUTs
 * the file, then calls :complete. Nothing is referable until it is `stored`.
 */
export async function reserveProposalDocumentByToken({ store, storage, token, body }) {
  const { proposal } = await resolveLiveTokenProposal(store, token);

  const errors = validateAttachmentFile(body?.file);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // Bound how many tickets one link may open — a hard cap on the anonymous
  // surface, checked before the reserve (a tiny race past the cap is harmless).
  if (await store.proposalDocumentCount(proposal.id) >= MAX_ATTACHMENTS_PER_PROPOSAL) {
    throw new ProblemError('validation_failed', null,
      { errors: { file: `at most ${MAX_ATTACHMENTS_PER_PROPOSAL} files per proposal` } });
  }

  const id = randomUUID();
  const key = attachmentStorageKey({ proposalId: proposal.id, documentId: id, fileName: body.file.name });
  // Sign BEFORE we persist. The presigned PUT needs only the storage key (which
  // is derived from the id we just minted) and the declared mime/sha256 — never
  // the DB row — so signing first costs nothing and means a presign failure
  // (a storage outage, a misconfigured endpoint) can't leave an orphan `pending`
  // row behind. Those orphans count against the per-link cap and would otherwise
  // wedge the whole surface at "at most N files" for a reason that has nothing
  // to do with the bidder.
  const { url, expiresAt } = await storage.signUpload({
    key, mime: body.file.mime, sha256Hex: String(body.file.sha256).toLowerCase(),
  });
  const document = await store.createProposalDocument({
    id, proposalId: proposal.id, storageKey: key, file: body.file,
  });
  return { status: 201, body: uploadTicketBody({ document, url, expiresAt }) };
}

/**
 * operationId: completeProposalDocumentByToken —
 * POST /rfp-links/{token}/documents/{documentId}:complete, security: [].
 *
 * Prove the bytes arrived: HEAD the object, check the stored size against the
 * declared one (sha256 was already pinned into the PUT), then flip the row to
 * `stored`. Only then may the submit reference it. The attachment must belong
 * to THIS token's proposal — a document id from another lane answers not_found.
 */
export async function completeProposalDocumentByToken({ store, storage, token, documentId }) {
  const { proposal } = await resolveLiveTokenProposal(store, token);
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  const doc = await store.getProposalDocument(documentId);
  if (!doc || doc.proposal_id !== proposal.id) throw new ProblemError('not_found');

  if (doc.status !== 'stored') {
    const head = await storage.head({ key: doc.storage_key });
    if (!head) {
      throw new ProblemError('validation_failed',
        'the file has not arrived in storage yet — PUT it to the ticket URL first',
        { errors: { upload: 'object not found in storage' } });
    }
    if (head.sizeBytes !== Number(doc.size_bytes)) {
      throw new ProblemError('validation_failed', null,
        { errors: { 'file.size_bytes': `declared ${doc.size_bytes}, stored ${head.sizeBytes}` } });
    }
  }
  const stored = await store.completeProposalDocument(documentId);
  return { status: 200, body: attachmentBody(stored) };
}

/**
 * operationId: downloadProposalDocument —
 * GET /proposals/{proposalId}/documents/{documentId}:download.
 *
 * The authed read side (no token — the viewer is a session): the issuer of the
 * RFP and the bidder org of the proposal may fetch a bidder's attachment; a
 * 302 to a short-lived presigned GET, exactly as the Documents module does.
 * Existence hiding: a non-party, or an id under a different proposal, is 404.
 */
export async function downloadProposalDocument({ viewer, store, storage, proposalId, documentId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  const doc = await store.proposalDocumentForDownload(documentId);
  if (!doc || doc.proposal_id !== proposalId || doc.status !== 'stored') {
    throw new ProblemError('not_found');
  }
  const isParty = doc.issuer_org_id === viewer.orgId
    || (doc.bidder_org_id != null && doc.bidder_org_id === viewer.orgId);
  if (!isParty) throw new ProblemError('not_found');

  const { url } = await storage.signDownload({ key: doc.storage_key, fileName: doc.file_name });
  return { status: 302, body: null, headers: { location: url, 'cache-control': 'no-store' } };
}

// ── RFP BIM model (LINA-409, doc 24; PRD-07 §5) ─────────────────────────────
// Since PRD-07 the model is the BUILD's: one project-scoped `bim` document
// (documents.document.is_project_model) that every participant reads. An RFP
// no longer owns a model — it REFERENCES the project model, following its
// current version or pinned to one (tendering.rfp.model_document_id /
// model_version_no). Bidders who are not participants see the model only
// through that reference (M-7), under the RFP read rule:
// the authed view-url via requireRfpRead, the public one with the token as the
// sole authority. Tendering owns the gate; the documents store owns
// persistence and the storage port owns bytes. Attaching, pinning and
// detaching are issuer-only on a draft. Uploading the .ifc itself follows the
// model's rule (PRD-07 M-9): the first model of a build may be put up by the
// issuer; later versions only by the model's author.

/** The RFP's model descriptor(s): [] or [the referenced model at its version]. */
async function loadRfpModels(documentsStore, rfp) {
  if (!documentsStore || !rfp?.model_document_id) return [];
  const doc = await documentsStore.getDocument(rfp.model_document_id);
  if (!doc || doc.current_version < 1) return [];
  const versionNo = rfp.model_version_no ?? doc.current_version;
  const version = await documentsStore.getVersion(doc.id, versionNo);
  return version ? [modelBody(doc, version, { pinned: rfp.model_version_no != null })] : [];
}

/** The document + version the RFP references, when `documentId` names it; else null
 *  (existence hiding: any other document id is indistinguishable from absent). */
async function rfpModelVersion(documentsStore, rfp, documentId) {
  if (!UUID.test(documentId ?? '') || rfp?.model_document_id !== documentId) return null;
  const doc = await documentsStore.getDocument(documentId);
  if (!doc || doc.kind !== 'bim' || doc.current_version < 1) return null;
  const version = await documentsStore.getVersion(documentId, rfp.model_version_no ?? doc.current_version);
  return version ? { doc, version } : null;
}

function requireDraftPackage(rfp, what) {
  if (rfp.status !== 'draft') {
    throw new ProblemError('invalid_transition', `the model can only be ${what} while the RFP is a draft`);
  }
}

/** operationId: reserveRfpModel — POST /rfps/{rfpId}/model. Issuer, draft only.
 *  Deprecated by PRD-07 (attachRfpModel): uploads the next .ifc of the BUILD's
 *  model — its first, or a new version when the issuer is the model's author —
 *  and `completeRfpModel` then attaches it to this RFP (following current). */
export async function reserveRfpModel({ viewer, store, documentsStore, storage, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  requireDraftPackage(rfp, 'attached');
  const errors = validateModelFile(body?.file);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = actorOf(await requireActor(store, viewer), viewer);
  // mime is normalised — IFC carries no agreed browser mime (domain MODEL_MIME).
  const file = { name: body.file.name, mime: MODEL_MIME, size_bytes: body.file.size_bytes, sha256: body.file.sha256 };
  const existing = await documentsStore.getProjectModel(rfp.project_id);

  let version;
  if (existing) {
    const documentId = existing.id;
    if (existing.current_version >= 1 && (await documentsStore.modelAuthorOrgId(documentId)) !== viewer.orgId) {
      throw new ProblemError('forbidden',
        'only the model\'s author uploads a new .ifc — attach the build\'s model to this RFP instead', { reason: 'relationship' });
    }
    version = await documentsStore.addVersion({
      documentId,
      file,
      meta: { changeKind: 'upload', baseVersionNo: existing.current_version || null },
      storageKeyOf: (versionNo) => documentStorageKey({ documentId, versionNo, fileName: file.name, random: randomUUID() }),
      actor,
    });
  } else {
    const id = randomUUID();
    version = await documentsStore.createDocument({
      id,
      projectId: rfp.project_id,
      scopeType: 'project',
      scopeId: rfp.project_id,
      kind: 'bim',
      title: file.name,
      shareWithAncestors: false,
      isProjectModel: true,
      file,
      storageKey: documentStorageKey({ documentId: id, versionNo: 1, fileName: file.name, random: randomUUID() }),
      actor,
    });
  }
  const { url, expiresAt } = await storage.signUpload({ key: version.storage_key, mime: version.mime, sha256Hex: version.sha256 });
  return {
    status: 201,
    body: { documentId: version.document_id, version: version.version_no, upload_url: url, expires_at: expiresAt },
  };
}

/** operationId: completeRfpModel — POST /rfps/{rfpId}/model/{documentId}:complete.
 *  Issuer. Prove the bytes arrived (size; sha256 was pinned into the PUT), advance
 *  the build model's version (documents store, ledgered), then attach it to this
 *  RFP following its current version. Returns the descriptor. */
export async function completeRfpModel({ viewer, store, documentsStore, storage, rfpId, documentId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  const doc = await documentsStore.getDocument(documentId);
  if (!doc || !doc.is_project_model || doc.project_id !== rfp.project_id) throw new ProblemError('not_found');
  // The version just reserved is the one above current, uploaded by this org.
  const versionNo = doc.current_version + 1;
  const version = await documentsStore.getVersion(documentId, versionNo);
  if (!version || version.uploaded_by_org_id !== viewer.orgId) throw new ProblemError('not_found');

  const head = await storage.head({ key: version.storage_key });
  if (!head) {
    throw new ProblemError('validation_failed', 'the file has not arrived in storage yet — PUT it to the ticket URL first',
      { errors: { upload: 'object not found in storage' } });
  }
  if (head.sizeBytes !== Number(version.size_bytes)) {
    throw new ProblemError('validation_failed', null,
      { errors: { 'file.size_bytes': `declared ${version.size_bytes}, stored ${head.sizeBytes}` } });
  }

  const actor = actorOf(await requireActor(store, viewer), viewer);
  const result = await documentsStore.completeUpload({ documentId, versionNo, actor });
  if (!result) throw new ProblemError('not_found');
  if (rfp.status === 'draft') await store.setRfpModel({ rfpId, documentId, versionNo: null });
  return { status: 200, body: modelBody(result.doc, version, { pinned: false }) };
}

/** operationId: attachRfpModel — PUT /rfps/{rfpId}/model. Issuer, draft only.
 *  The RFP references the build's model, following its current version
 *  (`version_no` null) or pinned to a proven one (PRD-07 §5). */
export async function attachRfpModel({ viewer, store, documentsStore, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  requireDraftPackage(rfp, 'attached');
  const errors = {};
  if (!UUID.test(body?.document_id ?? '')) errors.document_id = 'the build\'s model document id';
  const pin = body?.version_no ?? null;
  if (pin !== null && (!Number.isInteger(pin) || pin < 1)) errors.version_no = 'a version number, or null to follow the current version';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const model = await documentsStore.getProjectModel(rfp.project_id);
  if (!model || model.id !== body.document_id || model.current_version < 1) {
    throw new ProblemError('validation_failed', null, { errors: { document_id: 'the model of this RFP\'s build' } });
  }
  if (pin !== null && pin > model.current_version) {
    throw new ProblemError('validation_failed', null, { errors: { version_no: `a version from 1 to ${model.current_version}` } });
  }
  await store.setRfpModel({ rfpId, documentId: model.id, versionNo: pin });
  const version = await documentsStore.getVersion(model.id, pin ?? model.current_version);
  return { status: 200, body: modelBody(model, version, { pinned: pin !== null }) };
}

/** operationId: removeRfpModel — DELETE /rfps/{rfpId}/model/{documentId}.
 *  Issuer, draft only. DETACHES the build's model from the RFP; the model
 *  itself stays the build's (never deleted). 204. */
export async function removeRfpModel({ viewer, store, documentsStore, rfpId, documentId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  requireDraftPackage(rfp, 'removed');
  if (!(await rfpModelVersion(documentsStore, rfp, documentId))) throw new ProblemError('not_found');
  await store.setRfpModel({ rfpId, documentId: null, versionNo: null });
  return { status: 204, body: null };
}

/** operationId: rfpModelViewUrl — GET /rfps/{rfpId}/model/{documentId}:view-url.
 *  Any RFP reader (issuer or invited/open recipient). Short-TTL presigned INLINE
 *  GET of the version the RFP references. */
export async function rfpModelViewUrl({ viewer, store, documentsStore, storage, rfpId, documentId }) {
  const { rfp } = await requireRfpRead({ viewer, store, rfpId });
  const found = await rfpModelVersion(documentsStore, rfp, documentId);
  if (!found) throw new ProblemError('not_found');
  const { url, expiresAt } = await storage.signDownload({
    key: found.version.storage_key, fileName: found.doc.title, disposition: 'inline',
  });
  return { status: 200, body: { url, expiresAt } };
}

/** operationId: rfpModelViewUrlByToken —
 *  GET /rfp-links/{token}/model/{documentId}:view-url, security: [].
 *  The personal link IS the authority (same as getRfpByToken): resolve the RFP
 *  by token, uniform not_found for unknown/revoked/expired, then mint the inline
 *  GET. The token never reaches R2 — only the time-limited URL does. */
export async function rfpModelViewUrlByToken({ store, documentsStore, storage, token, documentId }) {
  const rec = await store.findRecipientByToken(token ?? '');
  if (!rec) throw new ProblemError('not_found', 'this link is not valid');
  const found = await rfpModelVersion(documentsStore, { model_document_id: rec.model_document_id, model_version_no: rec.model_version_no }, documentId);
  if (!found) throw new ProblemError('not_found');
  const { url, expiresAt } = await storage.signDownload({
    key: found.version.storage_key, fileName: found.doc.title, disposition: 'inline',
  });
  return { status: 200, body: { url, expiresAt } };
}

/** operationId: updateRfp — draft only, If-Match on version. */
export async function updateRfp({ viewer, store, rfpId, body, ifMatch }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  requireVersionMatch(ifMatch, rfp.version);
  if (rfp.status !== 'draft') {
    throw new ProblemError('invalid_transition', 'after publication the package changes only by an addendum');
  }
  const errors = {};
  if (body?.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) errors.title = 'required';
  if (body?.visibility !== undefined && !VISIBILITIES.has(body.visibility)) errors.visibility = 'invite_only or open';
  if (body?.listed !== undefined && typeof body.listed !== 'boolean') errors.listed = 'true or false';
  validateDeadlines(body, errors, { submissionRequired: false });
  validateExclusions(body, errors);
  if (body?.root_task_ids !== undefined) {
    const roots = body.root_task_ids;
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
      errors.root_task_ids = 'a non-empty list of task ids';
    }
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // The package is re-snapshotted when either its roots or its exclusions
  // change (T-3: "Include it" / "+ Add tasks from the plan" save per step).
  let snapshot = null;
  let roots = null;
  let excluded = null;
  if (body?.root_task_ids !== undefined || body?.excluded_task_ids !== undefined) {
    roots = body?.root_task_ids !== undefined ? [...new Set(body.root_task_ids)] : [...rfp.root_task_ids];
    excluded = body?.excluded_task_ids !== undefined
      ? [...new Set(body.excluded_task_ids)]
      : [...(rfp.excluded_task_ids ?? [])];
    const known = await store.tasksOfProject(rfp.project_id, roots);
    const missing = roots.filter((t) => !known.has(t));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
    }
    snapshot = scopedSnapshot(await store.snapshotPackage(rfp.project_id, roots), excluded);
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.updateRfp({
    rfpId,
    expectedVersion: rfp.version,
    set: {
      title: body?.title?.trim(),
      scopeText: body?.scope_text,
      listed: listedOf(body),
      questionsDeadline: body?.questions_deadline,
      submissionDeadline: body?.submission_deadline,
    },
    rootTaskIds: roots,
    excludedTaskIds: excluded,
    packageRows: snapshot?.rows ?? null,
    packageItems: snapshot?.items ?? null,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'the RFP changed under you — re-read it');
  return { status: 200, body: rfpBody(updated) };
}

// ── invite email dispatch (LINA-412, slice E) ────────────────────────────────
// The secure personal link a recipient receives. The token is placed ONLY here,
// in the body the mail sender puts on the wire — never a path, a header, or a
// log line (LINA-373/294). `/rfp/{token}` is the public, noindex form.
function secureLinkUrl(linkBaseUrl, token) {
  const base = String(linkBaseUrl || '').replace(/\/+$/, '');
  return `${base}/rfp/${token}`;
}

/**
 * Render + send one recipient's invite through the MailSender port, then record
 * the delivery breadcrumb (status→sent, sent_at, email_message_id). Resilient:
 * the dispatch runs AFTER the invite has committed, so a provider failure must
 * not fail the invite — it is swallowed (never re-throwing the body/token) and
 * the lane stays `queued` for a later re-issue to retry. Returns the (possibly
 * updated) recipient row and the message id (null when nothing was sent).
 */
export async function dispatchInvite({ store, mailSender, linkBaseUrl, rfp, recipient, token, reissue = false }) {
  if (!mailSender || !token) return { recipient, messageId: null };
  const email = renderInviteEmail({ rfp, linkUrl: secureLinkUrl(linkBaseUrl, token), reissue });
  try {
    const { id } = await mailSender.send({
      to: recipient.email, subject: email.subject, html: email.html, text: email.text,
    });
    const updated = await store.markRecipientSent({ rfpId: rfp.id, recipientId: recipient.id, messageId: id });
    return { recipient: updated ?? recipient, messageId: id };
  } catch {
    // Never surface the token-bearing body on an error path; leave it queued.
    return { recipient, messageId: null };
  }
}

/**
 * operationId: addRecipients — each opens a lane; one personal token each.
 * PRD-04 X-1/X-6: a recipient is a directory company (`company_id`, resolved
 * through the directory's published port: a claimed profile is its
 * organisation, an unclaimed one is invited at its e-mail), a platform
 * organisation (`org_id`) — both source `directory` — or an address (`email`,
 * source `email`).
 */
export async function addRecipients({ viewer, store, directory, mailSender, linkBaseUrl, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (!['draft', 'published'].includes(rfp.status)) {
    throw new ProblemError('invalid_transition', `cannot invite on a ${rfp.status} RFP`);
  }
  const list = body?.recipients;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ProblemError('validation_failed', null, { errors: { recipients: 'a non-empty list' } });
  }
  const errors = {};
  list.forEach((r, i) => {
    if (r?.company_id !== undefined) {
      if (!UUID.test(r.company_id ?? '')) errors[`recipients[${i}].company_id`] = 'a directory profile id';
      if (r.org_id !== undefined || r.email !== undefined) errors[`recipients[${i}]`] = 'company_id alone';
      return;
    }
    if (r?.org_id !== undefined && !UUID.test(r.org_id ?? '')) errors[`recipients[${i}].org_id`] = 'an organisation id';
    if (r?.org_id === undefined && !EMAIL.test(r?.email ?? '')) errors[`recipients[${i}].email`] = 'org_id, company_id or a valid email required';
    if (r?.email !== undefined && !EMAIL.test(r.email)) errors[`recipients[${i}].email`] = 'a valid email';
  });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const resolved = [];
  for (const r of list) {
    let orgId = r.org_id ?? null;
    let email = r.email ?? null;
    let companyName = null;
    let source = orgId ? 'directory' : 'email';
    if (r.company_id) {
      const company = directory ? await directory.contactOf(r.company_id) : null;
      if (!company) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: `no listed company ${r.company_id}` } });
      }
      source = 'directory';
      companyName = company.display_name;
      if (company.claimed) orgId = company.org_id;
      else email = company.email;
    }
    if (orgId) {
      const org = await store.getOrganization(orgId);
      if (!org) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: `unknown organisation ${orgId}` } });
      }
      if (org.id === rfp.issuer_org_id) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: 'the issuer cannot invite itself' } });
      }
      email = email ?? org.billing_email ?? org.contact_email ?? null;
      if (!email) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: `organisation ${org.id} has no contact email — pass one` } });
      }
      companyName = companyName ?? org.legal_name ?? null;
    }
    resolved.push({ orgId, email: email.toLowerCase(), name: companyName, source, companyName });
  }

  const actor = await requireActor(store, viewer);
  const created = await store.addRecipients({
    rfpId,
    projectId: rfp.project_id,
    recipients: resolved,
    actor: actorOf(actor, viewer),
    published: rfp.status === 'published',
  });
  // A DRAFT is private until it is sent (D-29, PRD-02 T-6/T-7): the recipient
  // is only queued — nothing is emailed and no token leaves the server (the
  // stored hash belongs to a token nobody holds; publishRfp mints the real
  // link). On a published RFP ("invite more") dispatch the invite email per
  // freshly-minted link (token !== null). An existing recipient (ON CONFLICT →
  // token null) is NOT re-sent here; use reissue for that. The token stays in
  // the 201 body too (issuer sees it once).
  const items = [];
  for (const { recipient, token } of created) {
    if (rfp.status === 'draft') { items.push(recipientBody(recipient)); continue; }
    const out = token
      ? await dispatchInvite({ store, mailSender, linkBaseUrl, rfp, recipient, token })
      : { recipient };
    items.push(recipientBody(out.recipient, { token }));
  }
  return { status: 201, body: { items, next_cursor: null } };
}

/**
 * operationId: previewInviteEmail — the issuer previews the invite email copy
 * BEFORE any send (pen frame 986). Rendered from the same renderer the dispatch
 * uses, so the preview is byte-for-byte the real email — EXCEPT the link, which
 * is a non-secret placeholder: a preview never carries a live token (LINA-373).
 * `?reissue=true` previews the rotated-link variant; `?email=` sets the sample
 * recipient shown in the `to` field. Issuer-only, same gate as addRecipients.
 */
export async function previewInviteEmail({ viewer, store, linkBaseUrl, rfpId, query }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  const reissue = query?.reissue === 'true' || query?.reissue === true;
  const to = EMAIL.test(query?.email ?? '') ? query.email : 'empreiteiro@exemplo.pt';
  const email = renderInviteEmail({
    rfp, linkUrl: secureLinkUrl(linkBaseUrl, PREVIEW_LINK_PLACEHOLDER_TOKEN), reissue,
  });
  return { status: 200, body: { to, subject: email.subject, html: email.html, text: email.text } };
}

/** operationId: listRecipients — per-recipient delivery status, issuer only. */
export async function listRecipients({ viewer, store, rfpId, query }) {
  await requireIssuer({ viewer, store, rfpId });
  const { items, nextCursor } = await store.listRecipients(rfpId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map((r) => recipientBody(r)), next_cursor: nextCursor } };
}

/**
 * operationId: reissueRecipientLink — rotate a recipient's personal link (gap
 * S1, LINA-373). A token can leak once it leaves our hands (a forwarded email,
 * a screenshot, a logged page URL); until now there was no way to kill one. This
 * mints a fresh token and invalidates the old in one step, so the issuer can
 * re-send a clean link. Issuer-only, same gate as addRecipients. Refused on a
 * cancelled/closed RFP (nothing left to bid on) and on a SPENT link (a submitted
 * lane) — rotating a spent link would hand a second single-use submission.
 */
export async function reissueRecipientLink({ viewer, store, mailSender, linkBaseUrl, rfpId, recipientId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (!UUID.test(recipientId ?? '')) throw new ProblemError('not_found', 'no such recipient');
  // A draft has no live links to rotate: they are minted at publish (T-7), and
  // a re-issue would email a bidder about a tender that was never sent.
  if (rfp.status !== 'published') {
    throw new ProblemError('invalid_transition', rfp.status === 'draft'
      ? 'the personal links are minted when the RFP is sent'
      : `cannot re-issue a link on a ${rfp.status} RFP`);
  }
  const rec = await store.getRecipient(rfpId, recipientId);
  if (!rec) throw new ProblemError('not_found', 'no such recipient');
  // Single-use is the invariant the public submit guards on (invited/draft ==
  // open). A link whose lane has left those states is spent; rotating it would
  // reopen a used submission, so refuse here with the same vocabulary the submit
  // uses for a spent link.
  if (!['invited', 'draft'].includes(rec.lane_status)) {
    throw new ProblemError('invalid_transition', 'this recipient has already submitted — their link cannot be re-issued');
  }
  const actor = await requireActor(store, viewer);
  const rotated = await store.reissueRecipientLink({
    rfpId, recipientId, projectId: rfp.project_id, actor: actorOf(actor, viewer),
  });
  // Null means the lane raced to spent between the read and the rotate; answer
  // the same refusal the pre-check would have.
  if (!rotated) throw new ProblemError('invalid_transition', 'this recipient has already submitted — their link cannot be re-issued');
  // Send the fresh link so the issuer need not copy-paste it (LINA-412). The
  // rotated token is still returned ONCE in the body, as before.
  const out = await dispatchInvite({
    store, mailSender, linkBaseUrl, rfp, recipient: rotated.recipient, token: rotated.token, reissue: true,
  });
  return { status: 200, body: recipientBody(out.recipient, { token: rotated.token }) };
}

/**
 * operationId: publishRfp — human-only; one individual email per recipient.
 * The personal links are minted HERE (PRD-02 T-7), in the publish transaction,
 * for every recipient still queued from the draft; each is then emailed. A mail
 * failure leaves that recipient queued for a re-issue — never fails the publish.
 */
export async function publishRfp({ viewer, store, builds = null, mailSender, linkBaseUrl, rfpId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId, humanOnly: 'publishing an RFP' });
  const outcome = rfpTransition(rfp.status, 'publish');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const recipients = await store.recipientCount(rfpId);
  if (recipients === 0 && !rfp.listed) {
    throw new ProblemError('validation_failed', null, { errors: { recipients: 'invite at least one recipient before publishing' } });
  }
  const actor = await requireActor(store, viewer);
  // The build's point and municipality, recorded on the RFP as it is listed:
  // "open requests near you" matches on them in SQL (0030, PRD-04 X-10).
  const [build] = builds ? await builds.factsOf([rfp.project_id]) : [];
  const published = await store.publishRfp({
    listingPoint: build ? { lat: build.lat, lng: build.lng, municipality_code: build.municipality_code } : null,
    rfpId, from: rfp.status, to: outcome.to,
    eventType: 'tendering.rfp.published',
    projectId: rfp.project_id,
    data: {
      visibility: rfp.visibility, listed: Boolean(rfp.listed),
      submission_deadline: iso(rfp.submission_deadline), specialties: rfp.specialties ?? [],
      specialty_codes: rfp.specialty_codes ?? [],
    },
    actor: actorOf(actor, viewer),
  });
  if (!published) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  for (const { recipient, token } of published.links) {
    await dispatchInvite({ store, mailSender, linkBaseUrl, rfp: published.rfp, recipient, token });
  }
  return { status: 200, body: rfpBody(published.rfp) };
}

/**
 * operationId: addAddendum — R2: after publication the package changes only
 * by a versioned addendum; all bidders are notified, deadlines may extend.
 */
export async function addAddendum({ viewer, store, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (rfp.status !== 'published') {
    throw new ProblemError('invalid_transition', 'an addendum amends a published RFP');
  }
  const errors = {};
  const summary = (body?.scope_text ?? body?.title ?? '').trim();
  if (!summary) errors.scope_text = 'describe what the addendum changes';
  validateDeadlines(body, errors, { submissionRequired: false });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // The package is re-snapshotted from the live plan rows (the issuer edits
  // the plan first, then issues the addendum that carries the change).
  const snapshot = scopedSnapshot(
    await store.snapshotPackage(rfp.project_id, rfp.root_task_ids), rfp.excluded_task_ids ?? [],
  );
  const actor = await requireActor(store, viewer);
  const updated = await store.addAddendum({
    rfpId,
    projectId: rfp.project_id,
    packageVersion: rfp.package_version + 1,
    summary,
    submissionDeadline: body?.submission_deadline ?? null,
    questionsDeadline: body?.questions_deadline ?? null,
    packageRows: snapshot.rows,
    packageItems: snapshot.items,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: rfpBody(updated) };
}

/** operationId: closeRfp — close early (the deadline close is the same move). */
export async function closeRfp({ viewer, store, rfpId }) {
  return transitionRfpOp({ viewer, store, rfpId, action: 'close', eventType: 'tendering.rfp.closed' });
}

/** operationId: cancelRfp — an optional one-line reason (PRD-02 T-19). */
export async function cancelRfp({ viewer, store, rfpId, body }) {
  const reason = body?.reason;
  if (reason !== undefined && reason !== null
      && (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500)) {
    throw new ProblemError('validation_failed', null, { errors: { reason: '1–500 characters' } });
  }
  const data = typeof reason === 'string' ? { reason: reason.trim() } : {};
  return transitionRfpOp({ viewer, store, rfpId, action: 'cancel', eventType: 'tendering.rfp.cancelled', data });
}

async function transitionRfpOp({ viewer, store, rfpId, action, eventType, data = {} }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  const outcome = rfpTransition(rfp.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionRfp({
    rfpId, from: rfp.status, to: outcome.to,
    eventType,
    projectId: rfp.project_id,
    data,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  return { status: 200, body: rfpBody(updated) };
}

// ── discovery (bidder side) ────────────────────────────────────────────────

/** operationId: browseOpenRfps — listed RFPs (D-15/D-47), published only. Deprecated by listOpenRequests. */
export async function browseOpenRfps({ viewer, store, query }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { items, nextCursor } = await store.browseOpenRfps({
    specialty: query?.specialty ?? null,
    municipality: query?.municipality ?? null,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(rfpBody), next_cursor: nextCursor } };
}

// operationId: applyToOpenRfp — ask to bid since D-47: ./bid-requests.mjs.
export { applyToOpenRfp } from './bid-requests.mjs';

/** operationId: listMyRfps — RFPs my org issued, was invited to, or applied to. */
export async function listMyRfps({ viewer, store, query }) {
  requireActiveOrg(viewer);
  const { items, nextCursor } = await store.listMyRfps(viewer.orgId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(rfpBody), next_cursor: nextCursor } };
}

// ── clarifications ─────────────────────────────────────────────────────────
// askClarification, askClarificationByToken, answerClarification live in
// ./clarifications.mjs (PRD-08); re-exported here so the operation list above
// stays the module's one index.
export { askClarification, askClarificationByToken, answerClarification } from './clarifications.mjs';

// ── proposals / lanes ──────────────────────────────────────────────────────

/** operationId: listProposalLanes — issuer: all lanes; bidder: only its own (V8). */
export async function listProposalLanes({ viewer, store, taskId, query }) {
  requireActiveOrg(viewer);
  const task = await store.getTask(taskId);
  if (!task) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: task.project_id });
  const { items, nextCursor } = await store.lanesForTask(taskId, {
    viewerOrgId: viewer.orgId,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  // The governing RFP of this row, for the plan/Gantt procurement window
  // (LINA-413). Read on the FIRST page only — the window is one fact about the
  // row, not something that paginates with the lanes. Null when the row has no
  // live tender (or the store predates this read).
  const rfp = !query?.cursor && store.rfpForTask
    ? await store.rfpForTask(taskId, viewer.orgId)
    : null;
  const seesMoney = viewer.has('org:money:view');
  return {
    status: 200,
    body: {
      items: items.map((l) => laneBody(l, { seesMoney })),
      rfp: rfp ? rfpWindowBody(rfp) : null,
      next_cursor: nextCursor,
    },
  };
}

/** operationId: getProposal — issuer | author only (V8, 404 for anyone else). */
export async function getProposal({ viewer, store, proposalId }) {
  const { proposal } = await requireLane({ viewer, store, proposalId });
  const doc = await store.proposalDoc(proposalId);
  const seesMoney = viewer.has('org:money:view');
  return { status: 200, body: proposalBody(proposal, { ...doc, seesMoney }) };
}

/** operationId: putProposal — the bidder builds ITS plan in ITS lane (D-36). */
export async function putProposal({ viewer, store, proposalId, body, ifMatch }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder writes in its lane', { reason: 'relationship' });
  requireVersionMatch(ifMatch, proposal.version);
  if (proposal.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'proposals are edited while the RFP is published');
  }
  if (new Date(proposal.submission_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the submission deadline has passed');
  }
  const outcome = proposalTransition(proposal.status, 'start_draft');
  // A submitted proposal is revised in place until the deadline (doc 09) —
  // the revision counter only moves on :submit.
  const nextStatus = proposal.status === 'submitted' ? 'submitted' : (outcome.ok ? outcome.to : null);
  if (!nextStatus) throw new ProblemError('invalid_transition', outcome.reason);

  const parsed = parseProposalDoc(body, { packageVersion: proposal.package_version });
  const itemIds = parsed.lines.filter((l) => l.rfpItemId).map((l) => l.rfpItemId);
  if (itemIds.length) {
    const known = await store.itemsOfRfp(proposal.rfp_id, itemIds);
    const missing = itemIds.filter((i) => !known.has(i));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { lines: `not items of this RFP: ${missing.join(', ')}` } });
    }
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.replaceProposalDoc({
    proposalId,
    expectedVersion: proposal.version,
    status: nextStatus,
    rows: parsed.rows,
    links: parsed.links,
    lines: parsed.lines,
    conditions: parsed.conditions,
    validityUntil: parsed.validityUntil,
    documentIds: parsed.documentIds,
    totalCents: parsed.totalCents,
    durationWd: parsed.durationWd,
    start: parsed.start,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'the proposal changed under you — re-read it');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/** operationId: submitProposal — new revision; the latest submitted counts. */
export async function submitProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder submits its lane', { reason: 'relationship' });
  if (proposal.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'the RFP is not open for submissions');
  }
  if (new Date(proposal.submission_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the submission deadline has passed');
  }
  if (proposal.channel === 'platform' && proposal.summary_total_cents == null) {
    throw new ProblemError('validation_failed', null, { errors: { lines: 'price the proposal before submitting' } });
  }
  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const updated = await store.submitProposal({
    proposalId,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: proposal.summary_total_cents ?? 0,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    bidderOrgId: viewer.orgId,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/**
 * operationId: submitOwnBid — POST /proposals/{proposalId}:submit-bid.
 *
 * The authenticated twin of submitProposalByToken: a self-serve bidder that
 * claimed its lane through the open marketplace (applyToOpenRfp, LINA-406) sends
 * a SUMMARY bid — one total, a duration, optional conditions/validity — in one
 * call, exactly the simple shape the public token form sends. It deliberately
 * does NOT reuse the token submit: that records the bid to the ledger as an
 * anonymous `public_link` with a null person, which would be a lie for a
 * signed-in bidder. Here the actor is the real submitting person+org and the
 * ledger notes `via: platform`.
 *
 * (The priced-BoQ path — putProposal/submitProposal — stays for bidders who build
 * a full plan in their lane; this is the lump-sum lane the marketplace needs, and
 * it stores summary fields directly with no rows/lines, the same honest shape the
 * public-token and offline summaries take.)
 *
 * `submit` is allowed from invited/draft/submitted, so a bidder may revise its
 * figure in place until the deadline; each send bumps the revision and the latest
 * submitted revision is the one the issuer compares.
 */
export async function submitOwnBid({ viewer, store, proposalId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder submits its lane', { reason: 'relationship' });
  if (proposal.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'the RFP is not open for submissions');
  }
  if (new Date(proposal.submission_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the submission deadline has passed');
  }
  const { errors, docs, referenceNotes } = await validateSummaryBid({ store, proposalId: proposal.id, body });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const updated = await store.submitOwnBid({
    proposalId: proposal.id,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: body.total.amount_cents,
    durationWd: body.duration_wd,
    conditions: body.conditions ?? null,
    validityUntil: body.validity_until ?? null,
    referenceNotes,
    documentIds: docs,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    bidderOrgId: viewer.orgId,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposal.id);
  // The bidder always sees the money on their own proposal.
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: true }) };
}

/** operationId: withdrawProposal — bidder, before award. */
export async function withdrawProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder withdraws its lane', { reason: 'relationship' });
  const outcome = proposalTransition(proposal.status, 'withdraw');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionProposal({
    proposalId, from: proposal.status, to: outcome.to,
    eventType: 'tendering.proposal.withdrawn',
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/** operationId: recordOfflineProposal — the issuer records an emailed answer. */
export async function recordOfflineProposal({ viewer, store, proposalId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isIssuer } = await requireLane({ viewer, store, proposalId });
  if (!isIssuer) throw new ProblemError('forbidden', 'only the issuer records an emailed answer', { reason: 'relationship' });
  if (proposal.rfp_status !== 'published' && proposal.rfp_status !== 'closed') {
    throw new ProblemError('invalid_transition', 'the RFP is no longer receiving answers');
  }
  const errors = {};
  const docs = body?.document_ids;
  if (!Array.isArray(docs) || docs.length === 0 || docs.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'the received documents (at least one id)';
  }
  if (!Number.isInteger(body?.total?.amount_cents) || body.total.amount_cents < 0) {
    errors.total = 'Money {amount_cents, currency}';
  } else if (body.total.currency !== 'EUR') errors.total = 'currency must be EUR';
  if (body?.duration_wd !== undefined && (!Number.isInteger(body.duration_wd) || body.duration_wd < 0)) {
    errors.duration_wd = 'working days ≥ 0';
  }
  if (body?.start !== undefined && !DATE_ONLY.test(body.start ?? '')) errors.start = 'YYYY-MM-DD';
  if (body?.validity_until !== undefined && !DATE_ONLY.test(body.validity_until ?? '')) errors.validity_until = 'YYYY-MM-DD';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // doc 09: invited → submitted directly when the issuer records the answer.
  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const updated = await store.recordOfflineProposal({
    proposalId,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: body.total.amount_cents,
    durationWd: body.duration_wd ?? null,
    start: body.start ?? null,
    conditions: body.conditions ?? null,
    validityUntil: body.validity_until ?? null,
    documentIds: [...new Set(docs)],
    recordedByPersonId: actor.id,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

// ── evaluation and award ───────────────────────────────────────────────────

/** operationId: getComparison — issuer only, behind org:money:view (16 §5). */
export async function getComparison({ viewer, store, rfpId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:money:view')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { rfp } = await requireIssuer({ viewer, store, rfpId, permission: null });
  const pkg = await store.packageOf(rfpId, rfp.package_version);
  const lanes = (await store.lanesOfRfp(rfpId))
    .filter((p) => ['submitted', 'shortlisted', 'awarded'].includes(p.status));
  const ids = lanes.map((p) => p.id);
  const lines = ids.length ? await store.linesOfProposals(ids) : [];
  const rows = ids.length ? await store.rowsOfProposals(ids) : [];
  const matrix = comparisonMatrix({ items: pkg.items, proposals: lanes, lines, rows });
  const seesMoney = true; // gated above — the comparison IS money
  return {
    status: 200,
    body: {
      proposals: lanes.map((l) => laneBody({
        ...l,
        missing_lines: missingLineCount(pkg.items, lines.filter((x) => x.proposal_id === l.id)),
        variant_lines: lines.filter((x) => x.proposal_id === l.id && x.is_variant).length,
        has_plan: rows.some((r) => r.proposal_id === l.id),
      }, { seesMoney })),
      ...matrix,
    },
  };
}

/** operationId: shortlistProposal — issuer; submitted → shortlisted. */
export async function shortlistProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isIssuer } = await requireLane({ viewer, store, proposalId });
  if (!isIssuer) throw new ProblemError('forbidden', 'only the issuer shortlists', { reason: 'relationship' });
  const outcome = proposalTransition(proposal.status, 'shortlist');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionProposal({
    proposalId, from: proposal.status, to: outcome.to,
    eventType: null, // ledger-only: doc 10 lists no .shortlisted event
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/**
 * operationId: awardRfp — human-only. One transaction: RFP → awarded, winner
 * lane → awarded, other live lanes → declined, and the CONTRACT DRAFT is
 * written by the contracting module's code on the same client (its award
 * port), so "awarded" can never exist without its contract. The plan copy +
 * baseline stay deferred to contracting.contract.signed (D-36).
 */
export async function awardRfp({ viewer, store, rfpId, body, contractingAward }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId, humanOnly: 'awarding an RFP' });

  const errors = {};
  if (!UUID.test(body?.proposal_id ?? '')) errors.proposal_id = 'the winning proposal id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const lanes = await store.lanesOfRfp(rfpId);
  const winner = lanes.find((p) => p.id === body.proposal_id);
  if (!winner) throw new ProblemError('not_found');
  const winnerMove = proposalTransition(winner.status, 'award');
  if (!winnerMove.ok) throw new ProblemError('invalid_transition', winnerMove.reason);
  if (!winner.bidder_org_id) {
    // An emailed bidder signs up before award: the contract needs a supplier
    // org (C1, NOT NULL) — same limitation as phase-3 supplier_email.
    throw new ProblemError('validation_failed', null, { errors: { proposal_id: 'the bidder has no organisation on the platform yet — it must sign up before award' } });
  }

  // Guard (doc 09): status closed, or published with every invitee responded.
  const allResponded = lanes.every((p) => !['invited', 'draft'].includes(p.status));
  if (rfp.status !== 'closed' && !(rfp.status === 'published' && allResponded)) {
    throw new ProblemError('invalid_transition', 'close the RFP first (or wait for every invitee to respond)');
  }

  const actor = await requireActor(store, viewer);
  const awarded = await store.awardRfp({
    rfpId,
    from: rfp.status,
    winnerProposalId: winner.id,
    // Every other live lane closes: answered ones lose, silent invitations
    // lapse — either way `declined` is the terminal evidence of the tender.
    declineProposalIds: lanes
      .filter((p) => p.id !== winner.id && ['invited', 'draft', 'submitted', 'shortlisted'].includes(p.status))
      .map((p) => p.id),
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null,
    projectId: rfp.project_id,
    actor: actorOf(actor, viewer),
    // D-43: what planning needs to take the branch baseline at award, carried
    // on tendering.rfp.awarded (planning never reads tendering tables).
    planFacts: awardedPlanFacts(rfp, winner),
    // The contracting module's award port, run on the SAME client/transaction.
    createContract: (client) => contractingAward(client, {
      rfp,
      winner,
      actor: actorOf(actor, viewer),
    }),
  });
  if (!awarded) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  // The issuer is the CLIENT of the new draft — full view; money still only
  // with org:money:view (16 §5), exactly as contracting projects it.
  const visibility = visibilityOf(awarded.contract, viewer.orgId);
  return {
    status: 201,
    body: contractBody(
      { ...awarded, signatures: [] },
      { visibility, canSeeMoney: viewer.has('org:money:view') },
    ),
  };
}

// ── shared helpers ─────────────────────────────────────────────────────────

/** Whole-document parse of #/components/schemas/Proposal (putProposal). */
function parseProposalDoc(body, { packageVersion }) {
  const errors = {};
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const links = Array.isArray(body?.links) ? body.links : [];
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (body?.rows !== undefined && !Array.isArray(body.rows)) errors.rows = 'a list';
  if (body?.links !== undefined && !Array.isArray(body.links)) errors.links = 'a list';
  if (body?.lines !== undefined && !Array.isArray(body.lines)) errors.lines = 'a list';

  const rowIds = new Set();
  rows.forEach((r, i) => {
    if (!UUID.test(r?.id ?? '')) errors[`rows[${i}].id`] = 'client-generated UUIDv7 required';
    else if (rowIds.has(r.id)) errors[`rows[${i}].id`] = 'duplicate row id';
    else rowIds.add(r.id);
    if (typeof r?.name !== 'string' || !r.name.trim()) errors[`rows[${i}].name`] = 'required';
    if (r?.kind !== undefined && !ROW_KINDS.has(r.kind)) errors[`rows[${i}].kind`] = 'task, summary or milestone';
    if (r?.packaged_task_id != null && !UUID.test(r.packaged_task_id)) errors[`rows[${i}].packaged_task_id`] = 'a task id';
    if (r?.parent_row_id != null && !UUID.test(r.parent_row_id)) errors[`rows[${i}].parent_row_id`] = 'a row id';
    if (r?.duration_wd !== undefined && r?.duration_wd !== null
        && (!Number.isInteger(r.duration_wd) || r.duration_wd < 0)) errors[`rows[${i}].duration_wd`] = 'working days ≥ 0';
    for (const f of ['start', 'finish']) {
      if (r?.[f] != null && !DATE_ONLY.test(r[f])) errors[`rows[${i}].${f}`] = 'YYYY-MM-DD';
    }
  });
  rows.forEach((r, i) => {
    if (r?.parent_row_id != null && UUID.test(r.parent_row_id) && !rowIds.has(r.parent_row_id)) {
      errors[`rows[${i}].parent_row_id`] = 'not a row of this proposal';
    }
  });
  links.forEach((l, i) => {
    if (!rowIds.has(l?.predecessor_id)) errors[`links[${i}].predecessor_id`] = 'not a row of this proposal';
    if (!rowIds.has(l?.successor_id)) errors[`links[${i}].successor_id`] = 'not a row of this proposal';
    if (!ANCHORS.has(l?.from_anchor)) errors[`links[${i}].from_anchor`] = 'start or end';
    if (!ANCHORS.has(l?.to_anchor)) errors[`links[${i}].to_anchor`] = 'start or end';
    if (l?.lag_wd !== undefined && !Number.isInteger(l.lag_wd)) errors[`links[${i}].lag_wd`] = 'an integer';
  });
  let totalCents = 0;
  lines.forEach((l, i) => {
    if (l?.rfp_item_id != null && !UUID.test(l.rfp_item_id)) errors[`lines[${i}].rfp_item_id`] = 'an item id';
    if (l?.proposal_row_id != null && !rowIds.has(l.proposal_row_id)) errors[`lines[${i}].proposal_row_id`] = 'not a row of this proposal';
    if (!l?.is_variant && l?.rfp_item_id == null) errors[`lines[${i}].rfp_item_id`] = 'required unless the line is a variant';
    if (typeof l?.description !== 'string' || !l.description.trim()) errors[`lines[${i}].description`] = 'required';
    if (typeof l?.unit !== 'string' || !l.unit.trim()) errors[`lines[${i}].unit`] = 'required';
    const qty = Number(l?.quantity);
    if (!Number.isFinite(qty) || qty < 0) errors[`lines[${i}].quantity`] = 'a quantity ≥ 0';
    const cents = l?.unit_price?.amount_cents;
    if (!Number.isInteger(cents) || cents < 0) errors[`lines[${i}].unit_price`] = 'Money {amount_cents ≥ 0, EUR}';
    else if (l.unit_price.currency !== 'EUR') errors[`lines[${i}].unit_price`] = 'currency must be EUR';
    else if (Number.isFinite(qty)) totalCents += Math.round(qty * cents);
  });
  if (body?.validity_until !== undefined && body?.validity_until !== null
      && !DATE_ONLY.test(body.validity_until)) errors.validity_until = 'YYYY-MM-DD';
  const documentIds = body?.document_ids ?? [];
  if (!Array.isArray(documentIds) || documentIds.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'a list of document ids';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // Summary derives from the bidder's own plan rows: the envelope of dated
  // top-level rows; duration the max row duration when nothing is dated.
  const dated = rows.filter((r) => r.start && r.finish);
  const start = dated.length ? dated.map((r) => r.start).sort()[0] : null;
  const finish = dated.length ? dated.map((r) => r.finish).sort().at(-1) : null;
  const durationWd = rows.reduce((max, r) => Math.max(max, r.duration_wd ?? 0), 0) || null;

  return {
    rows: rows.map((r, i) => ({
      id: r.id,
      packagedTaskId: r.packaged_task_id ?? null,
      parentRowId: r.parent_row_id ?? null,
      kind: r.kind ?? 'task',
      name: r.name.trim(),
      durationWd: r.duration_wd ?? null,
      start: r.start ?? null,
      finish: r.finish ?? null,
      position: String(i).padStart(6, '0'),
    })),
    links: links.map((l) => ({
      predecessorRow: l.predecessor_id,
      successorRow: l.successor_id,
      fromAnchor: l.from_anchor,
      toAnchor: l.to_anchor,
      lagWd: l.lag_wd ?? 0,
    })),
    lines: lines.map((l) => ({
      rfpItemId: l.rfp_item_id ?? null,
      proposalRowId: l.proposal_row_id ?? null,
      isVariant: Boolean(l.is_variant),
      description: l.description.trim(),
      unit: l.unit.trim(),
      quantity: Number(l.quantity),
      unitPriceCents: l.unit_price.amount_cents,
    })),
    conditions: typeof body?.conditions === 'string' ? body.conditions : null,
    validityUntil: body?.validity_until ?? null,
    documentIds: [...new Set(documentIds)],
    totalCents,
    durationWd,
    start,
    finish,
    packageVersion,
  };
}

/** excluded_task_ids: an optional list of task ids (draft scope, T-3). */
function validateExclusions(body, errors) {
  const ex = body?.excluded_task_ids;
  if (ex === undefined) return;
  if (!Array.isArray(ex) || ex.some((t) => !UUID.test(t ?? ''))) errors.excluded_task_ids = 'a list of task ids';
}

/** The roots' sub-trees minus the exclusions; a bad exclusion is a 422. */
function scopedSnapshot(snapshot, excluded) {
  const bad = exclusionError(snapshot.rows, excluded);
  if (bad) throw new ProblemError('validation_failed', null, { errors: { excluded_task_ids: bad } });
  return prunePackage(snapshot, excluded);
}

function validateDeadlines(body, errors, { submissionRequired }) {
  const ts = /^\d{4}-\d{2}-\d{2}T/;
  if (submissionRequired && !ts.test(body?.submission_deadline ?? '')) {
    errors.submission_deadline = 'an ISO timestamp';
  } else if (body?.submission_deadline !== undefined && !ts.test(body?.submission_deadline ?? '')) {
    errors.submission_deadline = 'an ISO timestamp';
  }
  if (body?.questions_deadline !== undefined && body?.questions_deadline !== null
      && !ts.test(body.questions_deadline)) {
    errors.questions_deadline = 'an ISO timestamp';
  }
  if (body?.questions_deadline && body?.submission_deadline
      && body.questions_deadline > body.submission_deadline) {
    errors.questions_deadline = 'before the submission deadline';
  }
}

/** Load an RFP as issuer (with existence hiding + staffing). */
export async function requireIssuer({ viewer, store, rfpId, humanOnly = null, permission = 'org:tendering:issue' }) {
  requireActiveOrg(viewer);
  if (humanOnly && viewer.channel === 'mcp') {
    throw new ProblemError('forbidden', `${humanOnly} is human-only`, { reason: 'human_only' });
  }
  if (permission && !viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const rfp = await store.getRfp(rfpId);
  // 404, not 403: a non-party never learns the RFP exists (V8).
  if (!rfp || rfp.issuer_org_id !== viewer.orgId) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: rfp.project_id });
  return { rfp };
}

/** Load an RFP as issuer OR recipient (getRfp). */
async function requireRfpRead({ viewer, store, rfpId }) {
  requireActiveOrg(viewer);
  const rfp = await store.getRfp(rfpId);
  if (!rfp) throw new ProblemError('not_found');
  const isIssuer = rfp.issuer_org_id === viewer.orgId;
  if (isIssuer) {
    await requireStaffing({ viewer, store, projectId: rfp.project_id });
    return { rfp, isIssuer };
  }
  // A listed published RFP is readable by any org that could ask to bid on
  // it (D-15/D-47); an unlisted one just by its recipients.
  const invited = await store.isRecipient(rfpId, viewer.orgId);
  const open = Boolean(rfp.listed) && rfp.status === 'published';
  if (!invited && !open) throw new ProblemError('not_found');
  return { rfp, isIssuer: false };
}

/** Load a proposal with its rfp facts; V8: issuer | author, 404 otherwise. */
async function requireLane({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  const proposal = await store.getProposal(proposalId);
  if (!proposal) throw new ProblemError('not_found');
  const isIssuer = proposal.issuer_org_id === viewer.orgId;
  const isAuthor = proposal.bidder_org_id === viewer.orgId;
  if (!isIssuer && !isAuthor) throw new ProblemError('not_found');
  if (isIssuer) await requireStaffing({ viewer, store, projectId: proposal.project_id });
  return { proposal, isIssuer, isAuthor };
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

export async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/**
 * Participant + staffing conjunction on the RFP's project (doc 16 §4).
 * Exported for the module's sibling queries (application/task-procurement.mjs).
 */
export async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  if (!related) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId });
  return { project };
}

/** Staffing only (the relationship was already proven another way). Exported for sibling use cases. */
export async function requireStaffing({ viewer, store, projectId }) {
  if (seesWholeOrg(viewer)) return;
  const actor = await requireActor(store, viewer);
  if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
    throw new ProblemError('not_a_participant', 'you are not staffed on this project');
  }
}

function requireVersionMatch(ifMatch, version) {
  if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
    throw new ProblemError('validation_failed', null, { errors: { 'If-Match': 'required — the current version' } });
  }
  if (String(ifMatch).replaceAll('"', '') !== String(version)) {
    throw new ProblemError('version_conflict', 'the resource changed under you — re-read it');
  }
}

export function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

/** `listed` wins; the deprecated `visibility` maps open → listed (D-47). */
function listedOf(body) {
  if (typeof body?.listed === 'boolean') return body.listed;
  if (body?.visibility !== undefined) return body.visibility === 'open';
  return undefined;
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
