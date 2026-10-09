// Pure v2-tendering wire → view transforms for the RFP composer and the
// proposals inbox (LINA-361, S5 of the UI cutover, doc 22 §3). Split out of
// `tendering.ts` (which does the I/O and imports `server-only`) so every mapping
// is unit-testable without a Clerk session or a router — the same discipline as
// `record-view.ts` / `profile-view.ts`, and as the v1 client this replaces kept
// its pure helpers testable in `procurement.test.mjs`.
//
// ── WHY A NEW MODULE, NOT AN EDIT OF THE V1 ONE ──────────────────────────────
// The v1 procurement client (`lib/procurement.ts`) modelled ONE RFP per
// procurement phase, flat recipients, and flat proposals quoting a budget range.
// v2 tendering (modules/tendering, live on /api/v2) is org-centric and far
// richer: per-task RFPs over a packaged BoQ, proposal LANES with rows/lines, a
// money-gated comparison matrix, and a shortlist/award/record-offline lifecycle.
// The two share almost no shape, so this is a fresh projection rather than a
// diff — the v1 file retires with the surface (LINA-361).
//
// ── THE RULES THIS FILE KEEPS ────────────────────────────────────────────────
//  1. MONEY MAY BE ABSENT, NOT ZERO. `total`/`unit_price`/`median` are withheld
//     from a viewer without `org:money:view` (wire invariant §6.5: withheld
//     fields are ABSENT, never null). A missing figure prints as "—", never €0 —
//     a zero would misdescribe a bid nobody is allowed to see.
//  2. UNKNOWN ENUM VALUES READ AS THEMSELVES. A BE enum widening shows up on
//     screen as the raw token rather than being silently coerced to a default,
//     so drift is visible instead of hidden (same rule the v1 badges kept).
//  3. NOTHING IS COMPUTED FROM A BID. The median and per-row prices come from
//     the server's comparison projection; this file formats them, it never
//     derives a total or a ranking. The issuer ranks bids, we do not.

// ── Wire shapes (subset), verbatim against modules/tendering/domain/wire.mjs
// and cowork/documentation/api/v2/openapi.yaml. Restated locally, the same
// discipline as `record-view.ts`: a drift in the module's projection lands as a
// type error here rather than as `undefined` under a bid.

export interface V2Money {
  amount_cents: number;
  currency: string;
}

/** #/components/schemas/Rfp.status — the RFP lifecycle (lifecycle.mjs). */
export type RfpStatus = 'draft' | 'published' | 'closed' | 'awarded' | 'cancelled';

/** #/components/schemas/Proposal.status / ProposalLane.status. */
export type ProposalStatus =
  | 'invited' | 'draft' | 'submitted' | 'withdrawn' | 'shortlisted' | 'awarded' | 'declined';

/** #/components/schemas/Recipient.status. */
export type RecipientStatus =
  | 'queued' | 'sent' | 'opened' | 'declined' | 'proposal_submitted' | 'bounced';

export type Channel = 'platform' | 'email';

export type RfpVisibility = 'invite_only' | 'open';

export type RfpLevel = 'owner' | 'sub';

/** D-39: design (pre-construction, light) vs execution (as-is, detailed). */
export type RfpPurpose = 'design' | 'execution';
export type RfpMode = 'light' | 'detailed';

/** One packaged BoQ item a bidder prices (packageBody.items). */
export interface V2PackageItem {
  rfp_item_id: string;
  task_id: string;
  code: string;
  description: string;
  unit: string;
  quantity: string;
  material_spec?: string;
  specialty?: string;
}

/** One subtree row of the tendered package (packageBody.rows). */
export interface V2PackageRow {
  task_id: string;
  parent_task_id?: string;
  name: string;
  scope_text?: string;
  specialty?: string;
  position: number;
}

/** An attached BIM model (packageBody.models, LINA-409 / doc 24 §RfpModel). */
export interface V2Model {
  documentId: string;
  version: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256?: string | null;
}

export interface V2Package {
  rows: V2PackageRow[];
  items: V2PackageItem[];
  /** Attached 3D models (Phase 1 surfaces models[0]); [] when none. */
  models: V2Model[];
}

/** #/components/schemas/Rfp (rfpBody). `package` is present only on getRfp. */
export interface V2Rfp {
  id: string;
  project_id: string;
  issuer_org_id: string;
  level: RfpLevel;
  purpose: RfpPurpose;
  mode: RfpMode;
  parent_contract_id?: string;
  root_task_ids: string[];
  title: string;
  scope_text?: string;
  specialties: string[];
  visibility: RfpVisibility;
  questions_deadline?: string;
  submission_deadline?: string;
  package_version: number;
  status: RfpStatus;
  awarded_proposal_id?: string;
  version: number;
  package?: V2Package;
}

/** #/components/schemas/Recipient — issuer only. `token` returned ONCE on add. */
export interface V2Recipient {
  id: string;
  org_id?: string;
  email: string;
  status: RecipientStatus;
  sent_at?: string;
  opened_at?: string;
  token?: string;
}

/** #/components/schemas/ProposalLane — the dashed pseudo-row (D-36). */
export interface V2ProposalLane {
  proposal_id: string;
  bidder: { org_id?: string; name?: string; email: string };
  channel: Channel;
  status: ProposalStatus;
  /** Absent without `org:money:view`. */
  total?: V2Money;
  duration_wd?: number;
  start?: string;
  finish?: string;
  missing_lines: number;
  variant_lines: number;
  document_count: number;
  has_plan: boolean;
  url: string;
}

/** #/components/schemas/Comparison — issuer only, behind `org:money:view`. */
export interface V2Comparison {
  proposals: V2ProposalLane[];
  items: {
    rfp_item_id: string;
    description: string;
    unit: string;
    quantity: string;
    /** proposal_id → unit price. Absent bidders simply have no key. */
    prices: Record<string, V2Money>;
    median?: V2Money;
    /** proposal_ids that never priced this line. */
    missing_in: string[];
  }[];
  durations: { packaged_task_id: string; by_proposal: Record<string, number> }[];
}

// ── Display helpers ──────────────────────────────────────────────────────────

/**
 * A wire Money as one phrase — "€180,000", or "—" when the figure is ABSENT.
 *
 * Absence is the money gate doing its job (rule 1): a viewer without
 * `org:money:view` gets no `total`/`unit_price`, and printing "—" is the honest
 * answer, never "€0". Whole euros, no cents — a bid is quoted in round money and
 * the extra precision would read as false accuracy.
 */
export function formatMoney(m: V2Money | null | undefined): string {
  if (!m || !Number.isFinite(m.amount_cents)) return '—';
  const sign = m.amount_cents < 0 ? '-' : '';
  const abs = Math.abs(m.amount_cents);
  const symbol = m.currency === 'EUR' ? '€' : `${m.currency} `;
  return `${sign}${symbol}${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  })}`;
}

/**
 * A proposal's lead time as whole weeks — the unit the compare cards and matrix
 * speak (LINA-420 designs; "9 wks", not "45 working days"). The wire carries
 * working days; a week is 5 working days (the platform's week, LINA-360). The
 * raw working-days figure stays available as the element's title for precision.
 * 0..4 wd still reads as "1 wk" so a short bid never shows "0 wks".
 */
export function leadTimeWeeks(durationWd: number | null | undefined): string {
  if (durationWd == null || !Number.isFinite(durationWd) || durationWd <= 0) return '—';
  const weeks = Math.max(1, Math.round(durationWd / 5));
  return `${weeks} ${weeks === 1 ? 'wk' : 'wks'}`;
}

/** The tone a badge wears, shared vocabulary with the plan primitives. */
export type BadgeTone = 'quiet' | 'live' | 'good' | 'off' | 'warn';

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * The RFP lifecycle in the issuer's words. `draft` is private; `published` is
 * out for bids; `closed` is no-longer-receiving; `awarded` is decided;
 * `cancelled` is abandoned. An unknown value reads as itself (rule 2).
 */
export function rfpStatusBadge(status: RfpStatus | string): StatusBadge {
  switch (status) {
    case 'draft': return { label: 'Draft — not sent', tone: 'quiet' };
    case 'published': return { label: 'Out for bids', tone: 'live' };
    case 'closed': return { label: 'Closed', tone: 'warn' };
    case 'awarded': return { label: 'Awarded', tone: 'good' };
    case 'cancelled': return { label: 'Cancelled', tone: 'off' };
    default: return { label: String(status), tone: 'quiet' };
  }
}

/** A bidder lane's status in the issuer's words. */
export function proposalStatusBadge(status: ProposalStatus | string): StatusBadge {
  switch (status) {
    case 'invited': return { label: 'Invited', tone: 'quiet' };
    case 'draft': return { label: 'Drafting', tone: 'quiet' };
    case 'submitted': return { label: 'Proposal in', tone: 'good' };
    case 'shortlisted': return { label: 'Shortlisted', tone: 'live' };
    case 'awarded': return { label: 'Awarded', tone: 'good' };
    case 'withdrawn': return { label: 'Withdrawn', tone: 'off' };
    case 'declined': return { label: 'Declined', tone: 'off' };
    default: return { label: String(status), tone: 'quiet' };
  }
}

/** A recipient's delivery/engagement status, in the issuer's words. */
export function recipientStatusBadge(status: RecipientStatus | string): StatusBadge {
  switch (status) {
    case 'queued': return { label: 'Queued', tone: 'quiet' };
    case 'sent': return { label: 'Invited', tone: 'quiet' };
    case 'opened': return { label: 'Viewed', tone: 'live' };
    case 'proposal_submitted': return { label: 'Proposal in', tone: 'good' };
    case 'declined': return { label: 'Declined', tone: 'off' };
    case 'bounced': return { label: 'Bounced', tone: 'warn' };
    default: return { label: String(status), tone: 'quiet' };
  }
}

// ── Recipient parsing (carried over from the v1 client, unchanged intent) ────
// People paste from a spreadsheet column, an email To: field, or a comma list,
// so commas, semicolons, newlines and tabs all separate. Addresses are
// lowercased because `Ana@Co.pt` and `ana@co.pt` are one contractor and
// inviting them twice mints two personal links for one bid. The server
// re-validates; a stricter regex here would reject valid addresses.

export interface ParsedRecipients {
  /** Well-formed, lowercased, de-duplicated, in first-seen order. */
  valid: string[];
  /** Kept verbatim so the person can see their own typo and fix it. */
  invalid: string[];
  /** Well-formed but already invited (or repeated in the paste). */
  duplicates: string[];
}

const EMAIL = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

export function parseRecipients(
  input: string, existing: readonly string[] = [],
): ParsedRecipients {
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];

  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim().replace(/^<|>$/g, '');
    if (!token) continue;
    const email = token.toLowerCase();
    if (!EMAIL.test(email)) { invalid.push(token); continue; }
    if (seen.has(email)) { duplicates.push(email); continue; }
    seen.add(email);
    valid.push(email);
  }

  return { valid, invalid, duplicates };
}

// ── Composer gating ──────────────────────────────────────────────────────────

/** The minimum a draft needs before it can be created against the API. */
export interface RfpDraftInput {
  title: string;
  scopeText: string;
  rootTaskIds: string[];
  submissionDeadline: string; // ISO date-time
  questionsDeadline?: string;
  visibility: RfpVisibility;
  /** D-39. Omit for the as-is execution tender; `design` pins the RFP light. */
  purpose?: RfpPurpose;
  mode?: RfpMode;
}

/**
 * Why "Create RFP" is off, or null when it is on.
 *
 * The three reasons are exactly the three createRfp will refuse on
 * (validation_failed): no title, no tendered tasks, no submission deadline. A
 * disabled button that will not say why is a dead end (rule kept from v1).
 */
export function createBlockedReason(draft: Pick<RfpDraftInput, 'title' | 'rootTaskIds' | 'submissionDeadline'>): string | null {
  if (draft.title.trim().length === 0) return 'Give the tender a title.';
  if (draft.rootTaskIds.length === 0) return 'Pick at least one task to put out to tender.';
  if (!draft.submissionDeadline) return 'Set a submission deadline.';
  return null;
}

/**
 * Why "Publish" is off, or null when it is on.
 *
 * publishRfp requires status `draft` and at least one recipient (an RFP with no
 * personal links minted reaches no bidder). The deadline being in the past is a
 * softer warning the caller may still choose to surface separately.
 */
export function publishBlockedReason(
  rfp: Pick<V2Rfp, 'status'> | null,
  recipientCount: number,
): string | null {
  if (!rfp) return 'Create the RFP first.';
  if (rfp.status !== 'draft') return 'This RFP has already been sent.';
  if (recipientCount === 0) return 'Add at least one contractor to send it to.';
  return null;
}

// ── Inbox ordering + award gating ────────────────────────────────────────────

/**
 * The lanes an issuer actually acts on, in the order the inbox reads them:
 * a proposal that is in (submitted/shortlisted/awarded) sorts above one still
 * out (invited/draft/withdrawn/declined), and within a group the most recently
 * interesting — shortlisted then submitted — leads. Ties keep bidder-email order
 * so the list is stable across reads (no server timestamp on a lane).
 */
const STATUS_RANK: Record<string, number> = {
  awarded: 0, shortlisted: 1, submitted: 2, draft: 3, invited: 4, withdrawn: 5, declined: 6,
};

export function orderLanes(lanes: readonly V2ProposalLane[]): V2ProposalLane[] {
  return [...lanes].sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.bidder.email.localeCompare(b.bidder.email);
  });
}

/** A lane the issuer can still act on with award/shortlist. */
export function isLive(lane: Pick<V2ProposalLane, 'status'>): boolean {
  return lane.status === 'submitted' || lane.status === 'shortlisted';
}

/**
 * Why the RFP cannot be awarded yet, or null when it can.
 *
 * awardRfp guards (doc 09): the RFP must be `closed`, OR `published` with every
 * invitee having responded; the winning lane must be live; and — the phase-3
 * limitation — an email bidder must have an org on the platform before it can
 * hold a contract. Restated here so the inbox can grey Award with its reason
 * rather than let the click 4xx.
 */
export function awardBlockedReason(
  rfp: Pick<V2Rfp, 'status'>,
  lanes: readonly V2ProposalLane[],
  winner: Pick<V2ProposalLane, 'status' | 'bidder'> | null,
): string | null {
  if (!winner) return 'Pick a proposal to award.';
  if (!isLive(winner)) return 'This proposal is not live — only a submitted or shortlisted bid can win.';
  if (!winner.bidder.org_id) {
    return 'This bidder has no organisation on the platform yet — they must sign up before you can award.';
  }
  const allResponded = lanes.every((l) => l.status !== 'invited' && l.status !== 'draft');
  if (rfp.status !== 'closed' && !(rfp.status === 'published' && allResponded)) {
    return 'Close the RFP first (or wait for every invitee to respond).';
  }
  return null;
}

/**
 * The specialties an RFP is tendering, for the composer's read-only chip row.
 *
 * v2 derives specialties from the tendered package (snapshotPackage), it is NOT
 * a free-text tag editor as v1 was — so the composer shows what the chosen tasks
 * imply rather than asking the issuer to retype it. Empty is a real, honest
 * state (the tasks carried no specialty).
 */
export function packageSpecialties(rfp: Pick<V2Rfp, 'specialties'>): string[] {
  return [...new Set(rfp.specialties ?? [])];
}

// ── Compare drill-down: renderer selection + light-bid detail (LINA-411) ──────
// Post-shortlist, the issuer opens a Compare SURFACE (not a modal) over the
// bids it shortlisted. Which renderer it gets is keyed off the RFP's shape
// (D-39): a detailed tender compares as the price MATRIX (per-line unit prices +
// medians); a light tender — a design/pre-construction service priced as a fee —
// has no BoQ to tabulate, so it compares as DOCS: the bidders' references, their
// notes and their portfolio PDFs set side by side.

/** Which renderer the Compare drill-down uses for an RFP. */
export type CompareRenderer = 'docs' | 'matrix';

/**
 * Light bids compare as Documents, detailed bids as the price Matrix. `mode` is
 * the discriminator — a design RFP is pinned light by the DB (rfp_design_is_light)
 * — with `purpose` as the backstop so an older row that predates the column still
 * resolves to Docs when it is a design tender.
 */
export function compareRenderer(rfp: Pick<V2Rfp, 'mode' | 'purpose'>): CompareRenderer {
  return rfp.mode === 'light' || rfp.purpose === 'design' ? 'docs' : 'matrix';
}

/** A bidder's answer as the Docs renderer shows it (a light bid), issuer-side. */
export interface V2ProposalDetail {
  proposal_id: string;
  reference_notes?: string;
  conditions?: string;
  validity_until?: string;
  /** Absent without `org:money:view` — prints "—", never €0. */
  total?: V2Money;
  duration_wd?: number;
  start?: string;
  /**
   * Portfolio attachment ids (issuer-visible subset). The per-file name is not on
   * the wire — the only route over these is the per-file download — so the Docs
   * renderer shows numbered links whose download carries the real filename.
   */
  document_ids: string[];
}

/** A proposal's portfolio attachment as the Docs renderer links to it. */
export interface V2ProposalDocument {
  id: string;
  title: string;
  mime?: string;
}

/**
 * Where the browser navigates to download a proposal's portfolio attachment: a
 * plain link the handler answers with a 302 to a short-lived presigned R2 URL
 * (issuer | author only). NOT routed through the server-only v2 client — the same
 * discipline as `taskDocumentDownloadPath`. The colon is a router command, so the
 * segments are encoded individually, never the whole path.
 */
export function proposalDocumentDownloadPath(proposalId: string, documentId: string): string {
  return `/api/v2/proposals/${encodeURIComponent(proposalId)}/documents/${encodeURIComponent(documentId)}:download`;
}

// ── Shortlist → Compare gating + the shareable `?compare=` param ──────────────

/**
 * The shortlisted lanes, in inbox order — the ones Compare drills into. An
 * awarded lane counts too, so a decided tender can still be opened to the
 * comparison it was decided on.
 */
export function shortlistedLanes(lanes: readonly V2ProposalLane[]): V2ProposalLane[] {
  return orderLanes(lanes).filter((l) => l.status === 'shortlisted' || l.status === 'awarded');
}

/**
 * Why "Compare" is off, or null when it is on. Compare opens the drill-down only
 * AFTER shortlisting (issue requirement) and needs at least two lanes to be a
 * comparison — a disabled button says which of the two it is waiting on.
 */
export function compareBlockedReason(lanes: readonly V2ProposalLane[]): string | null {
  const n = shortlistedLanes(lanes).length;
  if (n === 0) return 'Shortlist the bids you want to compare first.';
  if (n < 2) return 'Shortlist at least two bids to compare them.';
  return null;
}

const COMPARE_SEP = ',';

/** Serialize compared proposal ids into the shareable `?compare=` value. */
export function serializeCompareIds(ids: readonly string[]): string {
  return [...new Set(ids)].join(COMPARE_SEP);
}

/**
 * Read a `?compare=` value into ordered, de-duplicated proposal ids that are
 * actually bids on this RFP — a stale or hand-edited link silently drops ids that
 * are not lanes here rather than rendering an empty column. The order follows the
 * link (what the sharer arranged), filtered to `validIds`.
 */
export function parseCompareIds(raw: string | null | undefined, validIds: readonly string[]): string[] {
  if (!raw) return [];
  const valid = new Set(validIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(COMPARE_SEP)) {
    const id = part.trim();
    if (!id || seen.has(id) || !valid.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ── Recorded-offline money entry ─────────────────────────────────────────────

/**
 * Euros as a person types them → integer cents (what `:record-offline` wants), or
 * null when the field is empty/unparseable so the form can keep the button off.
 *
 * The last separator is a decimal point ONLY when exactly two digits trail it;
 * otherwise every separator is thousands grouping — so "1,500" is 1500, not 1.5,
 * and "180.000,50" is 18_000_050 cents. A bid is quoted in round money, so the
 * common case ("180000") needs no separators at all.
 */
export function eurosToCents(input: string): number | null {
  const normalized = input.trim().replace(/[^\d.,]/g, '');
  if (!normalized) return null;
  const lastSep = Math.max(normalized.lastIndexOf('.'), normalized.lastIndexOf(','));
  const isDecimal = lastSep >= 0 && normalized.length - lastSep - 1 === 2;
  const euros = Number((isDecimal ? normalized.slice(0, lastSep) : normalized).replace(/[.,]/g, '') || '0');
  const cents = isDecimal ? Number(normalized.slice(lastSep + 1)) : 0;
  if (!Number.isFinite(euros) || euros < 0 || !Number.isFinite(cents)) return null;
  return euros * 100 + cents;
}
