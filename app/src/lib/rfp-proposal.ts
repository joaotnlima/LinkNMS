// The token-scoped proposal client (LINA-284; BE half LINA-279).
//
// Contract: docs/architecture/slice-rfp-token-contract.md, derived from ADR-0023
// §5 (auth model) and §6 (UI surface map).
//
// ── WHY THIS SURFACE IS DIFFERENT FROM EVERY OTHER ONE ───────────────────────
// Nothing else in this app talks to the API without a Clerk session. Here the
// caller is a contractor who has never heard of LinkNMS, arrived from an email,
// and holds a 32-byte token in the URL and nothing else. Three consequences run
// through this file:
//
//   1. THE TOKEN IS THE CREDENTIAL, AND IT IS NEVER SENT IN A BODY. It travels
//      only in the path segment, exactly as the invitation preview does
//      (LINA-182). A body copy would end up in a log line that the URL at least
//      has a chance of being scrubbed from.
//
//   2. VALIDITY IS DERIVED, NOT STORED (ADR-0023 §5, Option A). A token is live
//      iff its RFP's procurement phase is still `active`. So "expired" is not a
//      date this client can compute or display — only the server can answer, and
//      the answer can flip between the page load and the submit. Both moments
//      therefore handle `rfp_closed`, and the copy never promises a deadline.
//
//   3. A REFUSAL MUST NOT LEAK WHETHER THE TOKEN EXISTS. The server answers a
//      uniform `not_found` for unknown AND dead tokens, so this file has one
//      sentence for both. Nothing here tries to tell them apart.
//
// Everything above `fetch` is pure and unit-tested (rfp-proposal.test.mjs): the
// draft validation, the URL normalisation, the timeline conversion, and the
// display formatters. The form never computes money — it parses what was typed
// into integer cents via the one parser this app has (lib/format.ts) and sends
// that; the budget figures on the record are the server's to hold.

import { parseAmountToCents } from './format.ts';

// ── Wire shapes (contract §3) ────────────────────────────────────────────────
// Restated locally on purpose, the same discipline as lib/task-workspace.ts: a
// drift in the schedule service's projection lands here as a type error rather
// than as `undefined` under a contractor's budget figure.

/** An R2 object reference — the shape ADR-0023 stores in `attachments` jsonb. */
export interface FileRef {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  url: string;
}

/** What the recipient is being asked to bid on. Read-only on this screen. */
export interface RfpView {
  /** The scope of works, as the owner/GC wrote it. */
  description: string;
  /** Drawings, renders, specs — whatever was attached to the RFP. */
  attachments: FileRef[];
  /** Trades this RFP is asking for, when the composer named any. May be empty. */
  specialties: string[];
}

/** Enough of the project to tell a contractor which job this is. */
export interface RfpProjectView {
  name: string;
  /** Free-text locality, not an address — this page is public. */
  location: string | null;
}

/** The proposal as the server holds it, echoed back on the confirmation page. */
export interface ProposalView {
  companyName: string;
  websiteUrl: string | null;
  portfolioImages: FileRef[];
  budgetMinCents: number;
  budgetMaxCents: number;
  timelineDays: number;
  comment: string | null;
  submittedAt: string;
}

/**
 * One read serves both pages.
 *
 * `proposal` is present iff this recipient has already submitted — which is what
 * lets `/rfp/[token]/submitted` render the details back without a second route,
 * and what lets the form page redirect a returning visitor instead of offering
 * them a second bid they cannot place.
 */
export interface RfpTokenView {
  project: RfpProjectView;
  rfp: RfpView;
  /** The invited email, shown so the recipient can see which address was invited. */
  recipientEmail: string;
  proposal: ProposalView | null;
}

/** A typed refusal, so a screen can react to the KIND rather than to prose. */
export class RfpTokenError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RfpTokenError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The two refusals this screen renders as a whole page rather than as a field
 * error. Both end the visit — there is no retry that would change the answer.
 */
export const DEAD_TOKEN_CODES = new Set(['not_found', 'rfp_closed']);

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** What the user typed, before any of it has been shown to be a number. */
export interface ProposalDraft {
  companyName: string;
  websiteUrl: string;
  budgetMin: string;
  budgetMax: string;
  timelineValue: string;
  timelineUnit: TimelineUnit;
  comment: string;
  portfolioImages: FileRef[];
}

export type TimelineUnit = 'days' | 'weeks';

/** The field-keyed errors a form renders beside the inputs that caused them. */
export type ProposalErrors = Partial<
  Record<'companyName' | 'websiteUrl' | 'budgetMin' | 'budgetMax' | 'timelineValue', string>
>;

/** The body the submit sends — integer cents and whole days, nothing derived. */
export interface ProposalBody {
  companyName: string;
  websiteUrl: string | null;
  portfolioImages: FileRef[];
  budgetMinCents: number;
  budgetMaxCents: number;
  timelineDays: number;
  comment: string | null;
}

export const EMPTY_DRAFT: ProposalDraft = {
  companyName: '',
  websiteUrl: '',
  budgetMin: '',
  budgetMax: '',
  timelineValue: '',
  timelineUnit: 'weeks',
  comment: '',
  portfolioImages: [],
};

/** The cap the server enforces too; stated here only so the hint can name it. */
export const MAX_PORTFOLIO_IMAGES = 8;
/** Matches the stage-attachment limit (LINA-249) — one number across the app. */
export const MAX_IMAGE_BYTES = 10 * 1000 * 1000;
export const MAX_COMMENT_CHARS = 4000;

/**
 * A typed website into something that can be linked, or null for "not given".
 *
 * A contractor types `acme-builders.com`, not `https://acme-builders.com`. We add
 * the scheme rather than refuse, because refusing over a missing `https://` reads
 * as a broken form to someone who is doing us a favour by bidding. What we do NOT
 * do is accept a scheme we would then render as a link: `javascript:` and `data:`
 * are rejected outright, because this URL gets rendered as an anchor on the
 * homeowner's proposals inbox — a surface with a real session behind it.
 *
 * @throws Error with a message intended for direct display in the form.
 */
export function normaliseWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a web address — e.g. acme-builders.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A website has to be an http:// or https:// address.');
  }
  // A hostname with no dot is a local name (`localhost`, a typo like `acmecom`),
  // never a company site. Rejecting it here is how we avoid publishing a dead
  // link on the homeowner's inbox.
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw new Error('That does not look like a web address — e.g. acme-builders.com');
  }
  return url.toString();
}

/**
 * A timeline in whatever unit was picked → whole days, which is what the column
 * stores (`timeline_days int CHECK > 0`).
 *
 * Weeks are the unit contractors actually estimate in, so the picker offers
 * both; the conversion is × 7 and happens once, here, rather than in the
 * component. Fractions are refused rather than rounded — "2.5 weeks" is a real
 * thing to want to say, but 17.5 days is not a thing the column can hold, and
 * silently storing 18 would put a number on the record nobody typed.
 */
export function timelineToDays(value: string, unit: TimelineUnit): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Enter the timeline as a whole number of ${unit}.`);
  }
  const n = Number(trimmed);
  if (n <= 0) throw new Error(`Enter the timeline as a whole number of ${unit}.`);
  const days = unit === 'weeks' ? n * 7 : n;
  // Ten years. Past that it is a typo, not an estimate, and the homeowner's
  // inbox should not have to display it.
  if (days > 3650) throw new Error('That timeline is longer than this form accepts.');
  return days;
}

/**
 * The whole draft, checked in one pass.
 *
 * It returns every error rather than throwing on the first: a person filling in
 * six fields should be told about all six problems at once, not walked through
 * them one submit at a time. The budget ordering check is the one rule that
 * spans two fields, and it is reported on `budgetMax` because that is the field
 * the person will change.
 */
export function validateProposalDraft(
  draft: ProposalDraft,
): { ok: true; body: ProposalBody } | { ok: false; errors: ProposalErrors } {
  const errors: ProposalErrors = {};

  const companyName = draft.companyName.trim();
  if (!companyName) errors.companyName = 'Tell the homeowner who is bidding.';
  else if (companyName.length > 200) errors.companyName = 'That company name is too long.';

  let websiteUrl: string | null = null;
  try {
    websiteUrl = normaliseWebsiteUrl(draft.websiteUrl);
  } catch (e) {
    errors.websiteUrl = (e as Error).message;
  }

  let budgetMinCents = 0;
  let budgetMaxCents = 0;
  try {
    budgetMinCents = parseAmountToCents(draft.budgetMin, { label: 'lowest figure' });
  } catch (e) {
    errors.budgetMin = draft.budgetMin.trim() ? (e as Error).message : 'Give a lowest figure.';
  }
  try {
    budgetMaxCents = parseAmountToCents(draft.budgetMax, { label: 'highest figure' });
  } catch (e) {
    errors.budgetMax = draft.budgetMax.trim() ? (e as Error).message : 'Give a highest figure.';
  }
  if (!errors.budgetMin && !errors.budgetMax && budgetMaxCents < budgetMinCents) {
    errors.budgetMax = 'The highest figure cannot be below the lowest one.';
  }

  let timelineDays = 0;
  try {
    timelineDays = timelineToDays(draft.timelineValue, draft.timelineUnit);
  } catch (e) {
    errors.timelineValue = draft.timelineValue.trim()
      ? (e as Error).message
      : 'Give a rough timeline.';
  }

  const comment = draft.comment.trim();
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      companyName,
      websiteUrl,
      portfolioImages: draft.portfolioImages,
      budgetMinCents,
      budgetMaxCents,
      timelineDays,
      comment: comment ? comment.slice(0, MAX_COMMENT_CHARS) : null,
    },
  };
}

/**
 * "$250,000 – $310,000", or a single figure when the two ends are equal.
 *
 * A range whose ends match is a fixed price, and printing it twice reads like a
 * rendering bug rather than like certainty.
 */
export function formatBudgetRange(minCents: number, maxCents: number): string {
  const fmt = (cents: number) =>
    `$${Math.round(cents / 100).toLocaleString('en-US')}`;
  return minCents === maxCents ? fmt(minCents) : `${fmt(minCents)} – ${fmt(maxCents)}`;
}

/**
 * Days back into the phrase a person would say.
 *
 * Exact multiples of 7 read as weeks because that is how they were almost
 * certainly entered; anything else stays in days rather than being rounded into
 * a week it is not.
 */
export function formatTimeline(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/** The confirmation page's address for this token. */
export function submittedPath(token: string): string {
  return `/rfp/${encodeURIComponent(token)}/submitted`;
}

// ── The three calls (contract §3) ────────────────────────────────────────────

function base(token: string): string {
  return `/api/rfp/token/${encodeURIComponent(token)}`;
}

/**
 * Turn a refusal into the typed error, with the wording a contractor should
 * read.
 *
 * The server's codes are the authority on WHAT happened; the sentences are this
 * surface's job. Note that `not_found` and `rfp_closed` deliberately get copy
 * that does not distinguish "this link was never real" from "this link has
 * closed" any more than it has to — the second is worth saying because it tells
 * the contractor not to chase it, the first must not become a probe oracle.
 */
async function refuse(res: Response): Promise<RfpTokenError> {
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* a proxy error page, not our JSON */ }
  const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? (res.status === 404 ? 'not_found' : 'internal');
  const said: Record<string, string> = {
    not_found: 'This link is not valid. Ask whoever invited you to send a new one.',
    rfp_closed: 'This RFP is no longer accepting proposals.',
    already_submitted: 'You have already sent a proposal for this project.',
    invalid_proposal: 'Some of these answers did not go through. Check the form and try again.',
    empty_file: 'That file is empty.',
    attachment_too_large: 'That image is over the 10 MB limit.',
    unsupported_content_type: 'That file is not an image — JPEG, PNG, WebP and HEIC are accepted.',
    invalid_filename: 'That file name will not do — rename it and try again.',
    too_many_images: `A proposal can carry up to ${MAX_PORTFOLIO_IMAGES} portfolio images.`,
  };
  return new RfpTokenError(
    code,
    said[code] ?? err?.message ?? 'That did not go through. Try again.',
    res.status,
  );
}

/**
 * GET /api/rfp/token/:token — the RFP behind the link (contract §3 route 1).
 *
 * This is also the call that mints the short-lived scoped cookie ADR-0023 §5
 * describes, which is why the form page makes it from the BROWSER rather than
 * from a server component: a `Set-Cookie` on a server-side fetch lands in the
 * server's response to itself and never reaches the visitor.
 */
export async function fetchRfpByToken(token: string): Promise<RfpTokenView> {
  const res = await fetch(base(token), { cache: 'no-store' });
  if (!res.ok) throw await refuse(res);
  return (await res.json()) as RfpTokenView;
}

/**
 * POST …/portfolio-images — upload one image (§3 route 2).
 *
 * One file per call, multipart with a single `file` part and nothing else: no
 * declared type, no size, no uploader. All of them are re-derived server-side,
 * and sending our copy would only create something for the two to disagree
 * about. Same shape as the stage attachment upload (LINA-249) on purpose.
 */
export async function uploadPortfolioImage(token: string, file: File): Promise<FileRef> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${base(token)}/portfolio-images`, { method: 'POST', body: form });
  if (!res.ok) throw await refuse(res);
  return ((await res.json()) as { image: FileRef }).image;
}

/**
 * POST …/proposal — send the bid (§3 route 3).
 *
 * The server re-checks the token AND that the phase is still active before it
 * writes, so a window that closed while the form was open fails here rather than
 * silently landing a bid nobody will read.
 */
export async function submitProposal(
  token: string, body: ProposalBody,
): Promise<ProposalView> {
  const res = await fetch(`${base(token)}/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refuse(res);
  return ((await res.json()) as { proposal: ProposalView }).proposal;
}
