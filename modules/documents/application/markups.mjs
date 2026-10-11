// The markup layer of a drawing (PRD-06) — one function per operationId:
//   listDocumentMarkups, saveDocumentMarkups, closeMarkup, reopenMarkup,
//   linkMarkup.
//
// Authorization is V6 (doc 04) on the document, as for downloads:
//   READ  — readers of the document's scope (existence hiding: 404 otherwise);
//   SAVE  — a participant reading a project / location / task file (the files
//           every participant shares, V1); never a contract, RFP, proposal or
//           private document — their audiences are narrower than a markup layer;
//   CLOSE — the markup's author org, or an editor of the document's scope;
//   LINK  — the markup's author org, pointing at a question it asked / an issue
//           it raised on the same build (checked through the Collaboration and
//           Quality query ports — documents never reads their tables).
//
// A markup becomes a question or an issue through those modules' own
// operations (createComment / raiseNonConformity) — the same aggregates, the
// same notifications; this module only records where the markup points.
import { ProblemError } from '../../../platform/errors.mjs';
import { documentBody } from '../domain/model.mjs';
import { PROJECT_FILE_SCOPES } from '../domain/files.mjs';
import {
  validateMarkupSave, validateMarkupLink, markupTransition, markupBody, sameMarkup,
} from '../domain/markup.mjs';
import { requireActiveOrg, requireActor, actorOf, requireReadableDocument } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampMarkupLimit(raw) {
  const n = Number(raw ?? 200);
  if (!Number.isInteger(n) || n < 1) return 200;
  return Math.min(n, 500);
}

/** operationId: listDocumentMarkups */
export async function listDocumentMarkups({ viewer, store, documentId, query }) {
  requireActiveOrg(viewer);
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  if (query?.cursor !== undefined && !UUID.test(query.cursor)) {
    throw new ProblemError('validation_failed', null, { errors: { cursor: 'an opaque cursor from next_cursor' } });
  }
  const doc = await requireReadableDocument({ viewer, store, documentId });
  const { items, nextCursor } = await store.listMarkups({
    documentId: doc.id, cursor: query?.cursor ?? null, limit: clampMarkupLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(markupBody), next_cursor: nextCursor } };
}

/** operationId: saveDocumentMarkups — appends the markups-only version n+1. */
export async function saveDocumentMarkups({ viewer, store, documentId, body, idempotencyKey = null }) {
  requireActiveOrg(viewer);
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  const doc = await requireReadableDocument({ viewer, store, documentId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'saveDocumentMarkups', body: { document_id: doc.id, ...body } },
    () => persistMarkups({ viewer, store, doc, body }),
  );
}

async function persistMarkups({ viewer, store, doc, body }) {
  if (!doc.project_id || !PROJECT_FILE_SCOPES.includes(doc.scope_type) || doc.private_to_org_id) {
    throw new ProblemError('forbidden', 'markups are kept on project, location and task files', { reason: 'scope' });
  }
  if (doc.is_project_model) {
    // The model's record-side edits are links and issue pins (PRD-07), saved by saveModelEdits.
    throw new ProblemError('forbidden', 'the project model takes links and issue pins, not drawing markups', { reason: 'scope' });
  }
  const { errors, drafts } = validateMarkupSave(body);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (doc.current_version < 1) throw new ProblemError('not_found');

  // Client ids are the idempotency key: a replay of the same markups answers
  // what was saved; an id that names another markup is a conflict.
  const existing = await store.getMarkupsByIds(drafts.map((d) => d.id));
  if (existing.length) {
    const byId = new Map(existing.map((r) => [r.id.toLowerCase(), r]));
    const replay = drafts.every((d) => {
      const row = byId.get(d.id.toLowerCase());
      return row && sameMarkup(row, d, { documentId: doc.id, authorOrgId: viewer.orgId });
    });
    if (!replay) throw new ProblemError('idempotency_mismatch', 'a markup id was already used by a different markup');
    const versions = await store.listVersions(doc.id, doc.current_version);
    return {
      status: 201,
      body: { document: documentBody(doc, versions), markups: drafts.map((d) => markupBody(byId.get(d.id.toLowerCase()))) },
    };
  }

  const actor = await requireActor(store, viewer);
  const saved = await store.saveMarkups({
    documentId: doc.id,
    baseVersionNo: body.base_version_no,
    drafts,
    note: typeof body.note === 'string' ? body.note : null,
    actor: actorOf(actor, viewer),
  });
  if (!saved) throw new ProblemError('not_found');
  if (saved.conflict !== undefined) {
    throw new ProblemError('version_conflict',
      `v${saved.conflict} was saved after the version these markups were drawn on — reopen the file and mark it up again`,
      { current_version: saved.conflict });
  }
  const versions = await store.listVersions(doc.id, saved.doc.current_version);
  return { status: 201, body: { document: documentBody(saved.doc, versions), markups: saved.markups.map(markupBody) } };
}

/** A markup the viewer can read, with its document; 404 otherwise. */
async function requireReadableMarkup({ viewer, store, markupId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(markupId ?? '')) throw new ProblemError('not_found');
  const markup = await store.getMarkup(markupId);
  if (!markup) throw new ProblemError('not_found');
  const doc = await requireReadableDocument({ viewer, store, documentId: markup.document_id });
  return { markup, doc };
}

async function changeState({ viewer, store, markupId, action, idempotencyKey }) {
  const { markup, doc } = await requireReadableMarkup({ viewer, store, markupId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: `${action}Markup`, body: { markup_id: markup.id } },
    () => transition({ viewer, store, markup, doc, action }),
  );
}

async function transition({ viewer, store, markup, doc, action }) {
  if (markup.author_org_id !== viewer.orgId
      && !(await store.canEditScope({ scopeType: doc.scope_type, scopeId: doc.scope_id, orgId: viewer.orgId }))) {
    throw new ProblemError('forbidden', 'only the organisation that drew the markup, or an editor of the file, closes it',
      { reason: 'relationship' });
  }
  const outcome = markupTransition(markup.state, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  if (outcome.noop) return { status: 200, body: markupBody(markup) };
  const actor = await requireActor(store, viewer);
  const row = await store.setMarkupState({ markupId: markup.id, to: outcome.to, actor: actorOf(actor, viewer) });
  if (!row) throw new ProblemError('not_found');
  return { status: 200, body: markupBody(row) };
}

/** operationId: closeMarkup */
export function closeMarkup({ viewer, store, markupId, idempotencyKey = null }) {
  return changeState({ viewer, store, markupId, action: 'close', idempotencyKey });
}

/** operationId: reopenMarkup */
export function reopenMarkup({ viewer, store, markupId, idempotencyKey = null }) {
  return changeState({ viewer, store, markupId, action: 'reopen', idempotencyKey });
}

/**
 * operationId: linkMarkup — `questions` is the Collaboration question port
 * (questionFacts), `nonconformities` the Quality port (nonconformityFacts),
 * both injected at the composition root.
 */
export async function linkMarkup({ viewer, store, questions = null, nonconformities = null, markupId, body, idempotencyKey = null }) {
  const { markup } = await requireReadableMarkup({ viewer, store, markupId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'linkMarkup', body: { markup_id: markup.id, ...body } },
    () => linkTo({ viewer, store, questions, nonconformities, markup, body }),
  );
}

async function linkTo({ viewer, store, questions, nonconformities, markup, body }) {
  if (markup.author_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the organisation that drew the markup links it', { reason: 'relationship' });
  }
  const { errors, link } = validateMarkupLink(body);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  if (link.questionId) {
    const q = questions ? await questions.questionFacts(link.questionId) : null;
    if (!q || q.project_id !== markup.project_id || q.author_org_id !== viewer.orgId) {
      throw new ProblemError('validation_failed', null,
        { errors: { question_id: 'a question your organisation asked on this build' } });
    }
    if (markup.question_id === q.id) return { status: 200, body: markupBody(markup) };
    if (markup.question_id) throw new ProblemError('invalid_transition', 'this markup already became another question');
  } else {
    const nc = nonconformities ? await nonconformities.nonconformityFacts(link.nonconformityId) : null;
    if (!nc || nc.project_id !== markup.project_id || nc.raised_by_org_id !== viewer.orgId) {
      throw new ProblemError('validation_failed', null,
        { errors: { nonconformity_id: 'an issue your organisation raised on this build' } });
    }
    if (markup.nonconformity_id === nc.id) return { status: 200, body: markupBody(markup) };
    if (markup.nonconformity_id) throw new ProblemError('invalid_transition', 'this markup already points at another issue');
  }
  const actor = await requireActor(store, viewer);
  const row = await store.linkMarkup({ markupId: markup.id, link, actor: actorOf(actor, viewer) });
  if (!row) throw new ProblemError('not_found');
  return { status: 200, body: markupBody(row) };
}
