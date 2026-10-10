// Clarifications — pure rules (no I/O), PRD-08 H-6..H-9, doc 06.
//
// Three rules live here so every surface (authed getRfp, the personal link,
// the tendering home) applies them identically:
//   1. WHEN a bidder may ask: the RFP is published and its questions deadline,
//      if any, has not passed (H-9). The use cases refuse on it; the reads
//      expose it as `questions_open` so no UI computes it.
//   2. WHAT a reader sees: the issuer sees every question; a bidder sees every
//      ANSWERED one (answers are public to all bidders, H-8 — no private
//      answers) plus its OWN open ones.
//   3. WHO asked is never on the wire (V8, H-7). The only viewer-relative fact
//      is `mine`, computed against the asker key the caller holds (its org, or
//      its personal-link recipient row).

export const MAX_QUESTION_LENGTH = 4000;
export const MAX_ANSWER_LENGTH = 8000;

/** Whether a bidder may still ask on this RFP at `now`. */
export function questionsOpen(rfp, now = new Date()) {
  if (!rfp || rfp.status !== 'published') return false;
  if (!rfp.questions_deadline) return true;
  const deadline = new Date(rfp.questions_deadline);
  if (Number.isNaN(deadline.getTime())) return true;
  return deadline.getTime() > now.getTime();
}

/** The reason asking is refused, or null when it is allowed. */
export function askRefusal(rfp, now = new Date()) {
  if (!rfp || rfp.status !== 'published') return 'questions are asked while the RFP is out for bids';
  if (!questionsOpen(rfp, now)) return 'the questions deadline has passed';
  return null;
}

/** Validate an ask body; returns field errors ({} when fine). */
export function questionErrors(body, uuidPattern) {
  const errors = {};
  if (!uuidPattern.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  const q = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!q) errors.question = 'required';
  else if (q.length > MAX_QUESTION_LENGTH) errors.question = `at most ${MAX_QUESTION_LENGTH} characters`;
  return errors;
}

/**
 * Does `row` belong to the asker identified by `asker` ({orgId?, recipientId?})?
 * An org match covers every question the org asked, through the app or a link
 * of its own; a recipient match covers a link-only bidder.
 */
export function askedBy(row, asker = {}) {
  if (asker.orgId && row.asked_by_org_id && row.asked_by_org_id === asker.orgId) return true;
  if (asker.recipientId && row.asked_by_recipient_id && row.asked_by_recipient_id === asker.recipientId) return true;
  return false;
}

/**
 * Rule 2: the rows a reader may see, each with its `mine` flag, ordered by
 * when they were asked. `isIssuer` sees all; anyone else sees answered rows
 * and its own.
 */
export function visibleClarifications(rows, { isIssuer = false, asker = {} } = {}) {
  return [...(rows ?? [])]
    .map((row) => ({ row, mine: !isIssuer && askedBy(row, asker) }))
    .filter(({ row, mine }) => isIssuer || row.status === 'answered' || mine)
    .sort((a, b) => timeOf(a.row.asked_at) - timeOf(b.row.asked_at)
      || String(a.row.id).localeCompare(String(b.row.id)));
}

/** Questions still waiting for the issuer. */
export function openQuestionCount(rows) {
  return (rows ?? []).filter((r) => r.status === 'open').length;
}

function timeOf(value) {
  const t = new Date(value ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}
