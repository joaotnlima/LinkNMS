// The public RFP link surface — pure wire shapes, validation and formatters
// (LINA-360, S5 of the UI cutover, doc 22). No I/O: the server-only reads and
// the submit live in `rfp-link.ts` (the same view/I-O split as
// record-view.ts / record.ts), so a *client* form component can import the
// validation and the draft type without dragging `server-only` into the bundle.
//
// ── WHY THIS SURFACE IS DIFFERENT FROM EVERY OTHER v2 ONE ─────────────────────
// Every other v2 read resolves a Clerk viewer. Here the caller is a contractor
// who has never heard of LinkNMS, arrived from an email, and holds a 64-hex
// token in the URL and nothing else. The v2 backend (LINA-322, modules/tendering,
// db/v2/0007) answers this with a `security: []` pair:
//
//   GET  /rfp-links/{token}            → the scope to price + the bidder's echo
//   POST /rfp-links/{token}/proposal   → the summary bid
//
// Three consequences run through this file and its I/O twin:
//
//   1. THE TOKEN IS THE CREDENTIAL, AND IT TRAVELS ONLY IN THE PATH. Unlike the
//      v1 surface it replaces, no cookie is minted — the token is re-supplied on
//      every call from the `[token]` route param, so BOTH pages can be plain
//      server components (v1 had to read from the browser to catch a Set-Cookie;
//      v2 has nothing to catch). See rfp-link.ts.
//
//   2. VALIDITY IS DERIVED, NOT STORED. A link is live iff its RFP is still
//      `published`; the GET carries `closed` so the form can say so without a
//      second call, and the POST re-checks — the window can shut between the two.
//
//   3. A REFUSAL MUST NOT LEAK WHETHER THE TOKEN EXISTS. The backend answers a
//      uniform `not_found` for unknown AND dead tokens, so this surface has one
//      sentence for both and never tries to tell them apart.
//
// ── THE BID SHAPE: A SINGLE TOTAL, NOT A RANGE (Architect ruling, LINA-360) ───
// The v1 form collected a budget RANGE (min/max), a timeline in days-or-weeks,
// a company name, a website and portfolio images. The v2 proposal model is a
// single summary `total` + `duration_wd`, org-centric (the bidder identity comes
// from the recipient record, not typed), and its whole downstream — the lanes,
// the proposal detail, the decide flow, the money view — is built on ONE total.
// A range on the public bid alone would fork the just-landed v2 wire. So the
// public bid COLLAPSES to a single total (EUR) + a working-day duration, with an
// optional conditions note and an optional validity date. Portfolio images ride
// the token-scoped upload route (LINA-370 BE / LINA-375 FE): the form uploads
// each file and carries the proven ids in `document_ids`.

import { parseAmountToCents } from '../format.ts';

// ── Wire shapes (modules/tendering/domain/wire.mjs) ──────────────────────────
// Restated locally on purpose, the same discipline as the other lib/v2 views: a
// drift in the tendering projection lands here as a type error rather than as
// `undefined` under a contractor's figure. Withheld fields are ABSENT, never
// null (wire invariant §6.5), so optionals are `?`, not `| null` — except
// `project.location` and `proposal`, which the projection sends as explicit null.

/** Money as the v2 wire sends it. `amount_cents` is an integer of `currency`. */
export interface V2Money {
  amount_cents: number;
  currency: string;
}

/** One structural row of the package a bidder prices (no prices — doc 05 §10). */
export interface PackageRow {
  task_id: string;
  parent_task_id?: string;
  name: string;
  scope_text?: string;
  specialty?: string;
  position: number;
}

/** An attached BIM model the bidder may view before pricing (LINA-409 / doc 24). */
export interface PackageModel {
  documentId: string;
  version: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256?: string | null;
}

/** One priced-by-the-bidder line of the package: quantities, never a price. */
export interface PackageItem {
  rfp_item_id: string;
  task_id: string;
  code: string;
  description: string;
  unit: string;
  /** Sent as a string to preserve the exact decimal the quantity was entered at. */
  quantity: string;
  material_spec?: string;
  specialty?: string;
}

/** The scope-of-works, structure + quantities, that the recipient is asked to bid. */
/** Design (pre-construction) vs execution — D-39. A design RFP is always
 *  `light`: the bid is a fee + portfolio + references + PDF, never a BoQ. */
export type RfpPurpose = 'design' | 'execution';
export type RfpMode = 'light' | 'detailed';

export interface RfpLinkRfp {
  title: string;
  scope_text?: string;
  specialties: string[];
  /** The bid shape the form must render — light asks for a fee + references,
   *  detailed for a priced BoQ (D-39). */
  purpose: RfpPurpose;
  mode: RfpMode;
  /** ISO datetime; absent when the RFP set no deadline. */
  submission_deadline?: string;
  package: { rows: PackageRow[]; items: PackageItem[]; models: PackageModel[] };
}

/** Enough of the project to tell a contractor which job this is. Public — a
 *  free-text locality, never an address. */
export interface RfpLinkProject {
  name: string;
  location: string | null;
}

/**
 * The bidder's OWN proposal, echoed back once it has left the `invited` state.
 * This is the full v2 Proposal projection; the confirmation page reads only the
 * summary the bidder sent. `summary` is present iff the money is visible, which
 * it always is on one's own proposal (wire.mjs `seesMoney` note).
 */
export interface ProposalEcho {
  id: string;
  status: string;
  revision: number;
  summary?: {
    total: V2Money;
    duration_wd?: number;
    start?: string;
  };
  conditions?: string;
  /** YYYY-MM-DD; absent when the bid named no validity date. */
  validity_until?: string;
  /** Light-bid references (referenceable past work / client contacts). */
  reference_notes?: string;
  document_ids: string[];
}

/**
 * `GET /rfp-links/{token}` — one read serves both pages.
 *
 * `proposal` is non-null iff this recipient has already submitted, which is what
 * lets `/rfp/[token]/submitted` render the details back without a second route,
 * and what lets the form page redirect a returning visitor instead of offering a
 * second bid they cannot place. `closed` is true when the RFP is no longer
 * `published` — the form says so without a second call.
 */
export interface RfpLinkView {
  project: RfpLinkProject;
  rfp: RfpLinkRfp;
  recipient_email: string;
  closed: boolean;
  proposal: ProposalEcho | null;
}

// ── The submit body (wire.mjs submitProposalByToken) ─────────────────────────

/** `POST /rfp-links/{token}/proposal` — the summary bid. */
export interface BidBody {
  total: V2Money;
  duration_wd: number;
  conditions?: string;
  validity_until?: string;
  /** Light-bid references — optional free text (≤4000 chars, BE-enforced). */
  reference_notes?: string;
  /**
   * Ids of portfolio attachments uploaded via the token-scoped upload route
   * (LINA-375), each already proven `stored`. The BE refuses any id that is not
   * a stored attachment of this proposal, so the form only ever puts completed
   * uploads here.
   */
  document_ids: string[];
}

// ── The draft the form holds (all strings, before anything is a number) ───────

export type DurationUnit = 'wd' | 'weeks';

export interface BidDraft {
  /** A typed money amount, e.g. "250000" or "250,000.00". */
  total: string;
  durationValue: string;
  durationUnit: DurationUnit;
  conditions: string;
  /** An <input type=date> value: "" or YYYY-MM-DD. */
  validityUntil: string;
  /**
   * Light-bid references (LINA-407): comparable past work and who to call. Only
   * the light form shows this box; a detailed bid leaves it empty and it is
   * never sent, so an execution tender is unchanged.
   */
  referenceNotes: string;
}

export const EMPTY_DRAFT: BidDraft = {
  total: '',
  durationValue: '',
  durationUnit: 'weeks',
  conditions: '',
  validityUntil: '',
  referenceNotes: '',
};

/** The field-keyed errors the form renders beside the inputs that caused them. */
export type BidErrors = Partial<
  Record<'total' | 'durationValue' | 'validityUntil' | 'conditions' | 'referenceNotes', string>
>;

/** The currency the whole v2 tender model records in; the BE refuses anything else. */
export const BID_CURRENCY = 'EUR';
/** A working week, in working days — the conversion the weeks picker applies. */
export const WORKING_DAYS_PER_WEEK = 5;
export const MAX_CONDITIONS_CHARS = 4000;
/** Light-bid references cap — mirrors the BE's ≤4000 (0010 / wire.mjs). */
export const MAX_REFERENCE_NOTES_CHARS = 4000;
/** Ten working years. Past that it is a typo, not an estimate. */
const MAX_WORKING_DAYS = 2600;

// ── Portfolio attachments (LINA-375) ─────────────────────────────────────────
// A client-side mirror of `modules/tendering/domain/attachment.mjs`: the same
// mime whitelist, size cap and per-proposal count the BE enforces, restated here
// so the form can refuse a file BEFORE spending a reserve round-trip — and so a
// drift in the BE envelope surfaces as a diff on this list, not as a 422 under a
// contractor's upload. The BE remains the authority; this is a courtesy.

/** Portfolio-shaped types: images a bidder shows work with, plus PDF. */
export const ALLOWED_ATTACHMENT_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf',
] as const;

/** 15 MB — generous for a site photo or a short PDF, small enough to bound abuse. */
export const MAX_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024;

/** A single link cannot attach an unbounded pile of files. */
export const MAX_PROPOSAL_ATTACHMENTS = 10;

/**
 * Pre-flight guard for one picked file: returns a display sentence when the file
 * is a type or size the BE would refuse, or `null` when it is worth reserving.
 * Mirrors `validateAttachmentFile` — same decisions, framed for a person.
 */
export function validateAttachmentFile(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(file.type)) {
    return 'That file type is not accepted. Use a JPEG, PNG, WebP, GIF, HEIC or PDF.';
  }
  if (file.size <= 0) return 'That file looks empty.';
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return 'That file is larger than 15 MB.';
  return null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** YYYY-MM-DD as of today, so the date picker can refuse a validity in the past. */
export function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A duration in whatever unit was picked → whole WORKING days, which is what the
 * column stores (`duration_wd int CHECK > 0`).
 *
 * Weeks are the unit contractors estimate in, so the picker offers both; a week
 * is FIVE working days here, not seven — the field is working days, and counting
 * weekends into a work estimate would put a wrong number on the record. Fractions
 * are refused rather than rounded, for the same reason the money parser refuses
 * them: "2.5 weeks" is a real thing to say but 12.5 working days is not a thing
 * the column can hold, and silently storing 13 would record a figure nobody typed.
 *
 * @throws Error with a message intended for direct display in the form.
 */
export function durationToWorkingDays(value: string, unit: DurationUnit): number {
  const trimmed = value.trim();
  const label = unit === 'weeks' ? 'weeks' : 'working days';
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Enter the duration as a whole number of ${label}.`);
  }
  const n = Number(trimmed);
  if (n <= 0) throw new Error(`Enter the duration as a whole number of ${label}.`);
  const wd = unit === 'weeks' ? n * WORKING_DAYS_PER_WEEK : n;
  if (wd > MAX_WORKING_DAYS) throw new Error('That duration is longer than this form accepts.');
  return wd;
}

/**
 * The whole draft, checked in one pass. Returns every error rather than throwing
 * on the first, so a person is told about all the problems at once.
 *
 * `now` is injected rather than read here so this stays pure and unit-testable —
 * the caller passes the request time.
 */
export function validateBid(
  draft: BidDraft,
  now: Date,
  documentIds: string[] = [],
): { ok: true; body: BidBody } | { ok: false; errors: BidErrors } {
  const errors: BidErrors = {};

  let totalCents = 0;
  try {
    totalCents = parseAmountToCents(draft.total, { label: 'total' });
    if (totalCents <= 0) errors.total = 'Enter the total you are bidding.';
  } catch (e) {
    errors.total = draft.total.trim() ? (e as Error).message : 'Enter the total you are bidding.';
  }

  let durationWd = 0;
  try {
    durationWd = durationToWorkingDays(draft.durationValue, draft.durationUnit);
  } catch (e) {
    errors.durationValue = draft.durationValue.trim()
      ? (e as Error).message
      : 'Give the duration of the works.';
  }

  let validityUntil: string | undefined;
  const rawValidity = draft.validityUntil.trim();
  if (rawValidity) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValidity) || Number.isNaN(Date.parse(rawValidity))) {
      errors.validityUntil = 'Enter a valid date.';
    } else if (rawValidity < todayIso(now)) {
      // A bid that is already expired the moment it is sent is almost certainly a
      // mistyped year; refuse it here rather than record a dead validity.
      errors.validityUntil = 'The validity date cannot be in the past.';
    } else {
      validityUntil = rawValidity;
    }
  }

  const conditions = draft.conditions.trim();
  if (conditions.length > MAX_CONDITIONS_CHARS) {
    errors.conditions = 'That note is too long.';
  }

  // Light-bid references (LINA-407): optional free text. The detailed form never
  // shows the box, so this is '' there and nothing is sent — an execution bid is
  // byte-for-byte unchanged. Only the length is guarded; the BE is the authority.
  const referenceNotes = draft.referenceNotes.trim();
  if (referenceNotes.length > MAX_REFERENCE_NOTES_CHARS) {
    errors.referenceNotes = 'Those references are too long.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      total: { amount_cents: totalCents, currency: BID_CURRENCY },
      duration_wd: durationWd,
      ...(conditions ? { conditions } : {}),
      ...(validityUntil ? { validity_until: validityUntil } : {}),
      ...(referenceNotes ? { reference_notes: referenceNotes } : {}),
      document_ids: documentIds,
    },
  };
}

// ── Display formatters ───────────────────────────────────────────────────────

/** "€250,000" — whole euros, the figure the whole proposal turns on. */
export function formatEuro(cents: number): string {
  const euros = Math.round(cents / 100);
  return `€${euros.toLocaleString('en-US')}`;
}

/** Working days back into the phrase a person would say, weeks where they divide. */
export function formatWorkingDays(wd: number): string {
  if (!Number.isFinite(wd) || wd <= 0) return '—';
  if (wd % WORKING_DAYS_PER_WEEK === 0) {
    const weeks = wd / WORKING_DAYS_PER_WEEK;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return wd === 1 ? '1 working day' : `${wd} working days`;
}

/** A YYYY-MM-DD wire date → the short display date, without inventing a timezone. */
export function formatDateOnly(iso: string): string {
  // Parse as a plain calendar date (append midday UTC) so a date-only value does
  // not slip a day under a negative local offset.
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The confirmation page's address for this token. */
export function submittedPath(token: string): string {
  return `/rfp/${encodeURIComponent(token)}/submitted`;
}

/** The form page's address for this token. */
export function formPath(token: string): string {
  return `/rfp/${encodeURIComponent(token)}`;
}
