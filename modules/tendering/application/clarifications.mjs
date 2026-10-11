// Tendering use cases — clarifications (PRD-08 H-6..H-9, doc 06):
//   askClarification         — a bidder org, in-app (session);
//   askClarificationByToken  — a bidder holding only the personal link (security: []);
//   answerClarification      — the issuer, published to EVERY bidder.
//
// Rules (domain/clarifications.mjs): asking only while the RFP is published and
// before its questions deadline — refused HERE, whatever the form shows (H-9);
// answers are public to all bidders, no private answers (PRD-08 §5); the asker
// is stored and ledgered but never projected (V8, H-7).
//
// On answer the store publishes `tendering.clarification.answered` on the
// outbox in the answer's transaction (doc 10 — the notification centre, PRD-12,
// consumes it). Token-only bidders have no notification centre, so each is
// also emailed a notice through the MailSender port AFTER commit, best-effort,
// exactly as the invite dispatch (a provider failure never fails the answer).
import { ProblemError } from '../../../platform/errors.mjs';
import { askRefusal, questionErrors, MAX_ANSWER_LENGTH } from '../domain/clarifications.mjs';
import { renderClarificationAnsweredEmail } from '../domain/clarification-email.mjs';
import { clarificationBody } from '../domain/wire.mjs';
import { actorOf, requireActor, requireStaffing } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** operationId: askClarification — recipient org only; the question stays open. */
export async function askClarification({ viewer, store, rfpId, body, now = new Date() }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const rfp = await store.getRfp(rfpId);
  if (!rfp) throw new ProblemError('not_found');
  if (!(await store.isRecipient(rfpId, viewer.orgId))) throw new ProblemError('not_found');
  const refusal = askRefusal(rfp, now);
  if (refusal) throw new ProblemError('invalid_transition', refusal);
  const errors = questionErrors(body, UUID);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const replay = await replayed(store, body.id, rfpId, (c) => c.asked_by_org_id === viewer.orgId);
  if (replay) return replay;

  const actor = await requireActor(store, viewer);
  const created = await store.askClarification({
    id: body.id,
    rfpId,
    projectId: rfp.project_id,
    askedByOrgId: viewer.orgId,
    question: body.question.trim(),
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: clarificationBody(created, { mine: true }) };
}

/**
 * operationId: askClarificationByToken — POST /rfp-links/{token}/clarifications,
 * security: []. The token is the authority; an unknown, revoked or expired one
 * answers the same not_found as every other link endpoint (no oracle).
 */
export async function askClarificationByToken({ store, token, body, idempotencyKey = null, now = new Date() }) {
  const rec = await store.findRecipientByToken(token ?? '');
  if (!rec) throw new ProblemError('not_found', 'this link is not valid');
  // No signed-in caller: the link's recipient is the idempotency caller.
  return store.idempotent(
    { key: idempotencyKey, caller: `rfp-link:${rec.id}`, operationId: 'askClarificationByToken', body },
    () => askByToken({ store, rec, body, now }),
  );
}

async function askByToken({ store, rec, body, now }) {
  const refusal = askRefusal({ status: rec.rfp_status, questions_deadline: rec.questions_deadline }, now);
  if (refusal) throw new ProblemError('invalid_transition', refusal);
  const errors = questionErrors(body, UUID);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const replay = await replayed(store, body.id, rec.rfp_id, (c) => c.asked_by_recipient_id === rec.id);
  if (replay) return replay;

  const created = await store.askClarification({
    id: body.id,
    rfpId: rec.rfp_id,
    projectId: rec.project_id,
    askedByOrgId: rec.org_id ?? null,
    askedByRecipientId: rec.id,
    question: body.question.trim(),
    // Anonymous actor, as the token proposal submit records it.
    actor: { personId: null, orgId: rec.org_id ?? null, orgRole: null, channel: 'ui' },
  });
  return { status: 201, body: clarificationBody(created, { mine: true }) };
}

/** operationId: answerClarification — published to all bidders, asker anonymised. */
export async function answerClarification({ viewer, store, builds = null, mailSender, clarificationId, body }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const clarification = await store.getClarification(clarificationId);
  if (!clarification) throw new ProblemError('not_found');
  const rfp = await store.getRfp(clarification.rfp_id);
  if (!rfp || rfp.issuer_org_id !== viewer.orgId) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: rfp.project_id });
  if (clarification.status !== 'open') {
    throw new ProblemError('invalid_transition', 'this question was already answered');
  }
  const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
  if (!answer) throw new ProblemError('validation_failed', null, { errors: { answer: 'required' } });
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw new ProblemError('validation_failed', null, { errors: { answer: `at most ${MAX_ANSWER_LENGTH} characters` } });
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.answerClarification({
    clarificationId,
    rfpId: rfp.id,
    projectId: rfp.project_id,
    answer,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'this question was already answered');
  await notifyTokenOnlyBidders({ store, builds, mailSender, rfp, clarification: updated });
  return { status: 200, body: clarificationBody(updated) };
}

/**
 * Email each token-only bidder (no platform org → no notification centre) the
 * published answer. After commit and best-effort: a send failure is swallowed,
 * the answer stands, the bidder still sees it on their link.
 */
async function notifyTokenOnlyBidders({ store, builds, mailSender, rfp, clarification }) {
  if (!mailSender || typeof store.tokenOnlyRecipients !== 'function') return;
  let recipients;
  let projectName = null;
  try {
    recipients = await store.tokenOnlyRecipients(rfp.id);
    // The build's name through the project's build port (tendering never reads project.*).
    if (recipients.length && builds) projectName = (await builds.factsOf([rfp.project_id]))[0]?.name ?? null;
  } catch {
    return;
  }
  const email = renderClarificationAnsweredEmail({
    rfp: { title: rfp.title, project_name: projectName },
    question: clarification.question,
    answer: clarification.answer,
  });
  for (const r of recipients) {
    try {
      await mailSender.send({ to: r.email, subject: email.subject, html: email.html, text: email.text });
    } catch {
      // Best-effort: one bad address never stops the others.
    }
  }
}

/** Idempotent replay on the client id: same asker + RFP → the stored row; else a mismatch. */
async function replayed(store, id, rfpId, sameAsker) {
  const existing = await store.getClarification(id);
  if (!existing) return null;
  if (existing.rfp_id === rfpId && sameAsker(existing)) {
    return { status: 201, body: clarificationBody(existing, { mine: true }) };
  }
  throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
}
