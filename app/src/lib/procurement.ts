// The procurement client — the RFP and the proposals that come back (LINA-283).
//
// Design: ADR-0023 §2 (schema), §4 (single `/plan` page), §6 (UI surface map).
// BE halves: LINA-279 (RFP create/send/token submission), LINA-280 (constructor
// selection), LINA-278 (phase lifecycle). Contract restated at
// docs/architecture/slice-procurement-contract.md.
//
// ── THE RULES THIS FILE KEEPS ────────────────────────────────────────────────
//  1. THE ACTOR IS NEVER IN THE BODY. Every call is project-scoped and the
//     acting party is the session, stamped server-side. A client that could name
//     the selector could hand the build to a constructor nobody chose.
//  2. MONEY IS INTEGER CENTS ON THE WIRE, formatted only for display (ADR §2:
//     `budget_min_cents` / `budget_max_cents` are bigint). Nothing here computes
//     a budget — a proposal's range is quoted, never arithmetic'd.
//  3. A SENT RFP IS NOT AN EDITABLE ONE. `status` is the authority on what the
//     composer may still change; recipients are added and removed while the RFP
//     is a draft, and the send is the one-way door (ADR §5 — tokens are minted
//     at send and die with the phase).
//  4. PROPOSALS ARE NEVER DROPPED. Selecting a constructor does not remove the
//     losers: the inbox keeps every proposal permanently, because "who else bid,
//     and for how much" is exactly the lookup this product exists for.
//  5. NO LOCAL EXPIRY MATHS. A token's validity is derived server-side from the
//     phase status (ADR §5, Option A). This file never computes "expired".
//
// Everything above `fetch` is pure and unit-tested (procurement.test.mjs): the
// recipient parser, the status vocabulary, and the two money/timeline formatters
// that print a stranger's bid back to the owner.

// ── Wire shapes (ADR-0023 §2) ────────────────────────────────────────────────
// Restated locally, the same discipline as lib/task-workspace.ts: a drift in the
// schedule service's projection lands as a type error here rather than as
// `undefined` under a bid.

/** `schedule.project_phase.status` — the single source of truth for what is open. */
export type PhaseStatus = 'pending' | 'active' | 'signed_off' | 'archived';

export type PhaseKind = 'pre_design' | 'procurement' | 'execution' | 'close_out';

export interface PhaseView {
  id: string;
  kind: PhaseKind;
  name: string;
  status: PhaseStatus;
  sequence: number;
}

/** `schedule.rfp.attachments` / `rfp_proposal.portfolio_images` — one R2 ref. */
export interface FileRef {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  url: string;
}

export type RfpStatus = 'draft' | 'sent' | 'closed';

export interface RfpView {
  id: string;
  phaseId: string;
  description: string;
  attachments: FileRef[];
  /**
   * The trades this RFP is asking for.
   *
   * CONTRACT GAP, flagged to LINA-279: ADR-0023 §2 has no column for this and
   * the issue asks for specialty tags on the composer. It is typed required here
   * because a tag editor that silently drops what was typed would be worse than
   * no tag editor — BE adds `rfp.specialties text[] NOT NULL DEFAULT '{}'` in
   * migration 0012 and echoes it back.
   */
  specialties: string[];
  status: RfpStatus;
  updatedAt: string;
}

export type RecipientStatus = 'invited' | 'viewed' | 'submitted' | 'declined';

export interface RecipientView {
  id: string;
  email: string;
  status: RecipientStatus;
}

export interface ProposalView {
  id: string;
  rfpRecipientId: string;
  companyName: string;
  websiteUrl: string | null;
  portfolioImages: FileRef[];
  budgetMinCents: number;
  budgetMaxCents: number;
  timelineDays: number;
  comment: string | null;
  submittedAt: string;
}

/** One read for the whole accordion section. */
export interface ProcurementView {
  phase: PhaseView;
  /** Null until the owner starts one — the "Create RFP" state. */
  rfp: RfpView | null;
  recipients: RecipientView[];
  proposals: ProposalView[];
  /** The proposal whose company was chosen, if the selection already happened. */
  selectedProposalId: string | null;
}

/** A typed refusal, so a screen can react to the KIND rather than to prose. */
export class ProcurementError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProcurementError';
    this.code = code;
    this.status = status;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** What one line of pasted text yielded, so the composer can say which line was wrong. */
export interface ParsedRecipients {
  /** Well-formed, lowercased, de-duplicated, in first-seen order. */
  valid: string[];
  /** Kept verbatim so the person can see their own typo and fix it. */
  invalid: string[];
  /** Well-formed but already on the list (or repeated in the paste). */
  duplicates: string[];
}

// Deliberately permissive: one @, something either side, a dot in the domain.
// The server re-validates and the mail provider is the real authority — a
// stricter regex here would reject valid addresses (plus-tags, new TLDs) and
// the owner would have no way to argue with it.
const EMAIL = /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/;

/**
 * Turn a paste — or one typed address — into a recipient list.
 *
 * Bulk-add is the same code path as add-one (the issue asks for both): people
 * paste from a spreadsheet column, an email To: field, or a comma list, so
 * commas, semicolons, newlines and tabs all separate. Addresses are lowercased
 * because `Ana@Co.pt` and `ana@co.pt` are one contractor and inviting them twice
 * sends two tokens for one bid.
 *
 * `existing` is the list already on the RFP: re-pasting the whole column after
 * adding two names must add the two, not error on the rest.
 */
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

/** The badge beside a recipient — the word, and the tone class it wears. */
export interface StatusBadge {
  label: string;
  tone: 'quiet' | 'live' | 'good' | 'off';
}

/**
 * The recipient vocabulary (ADR-0023 §2 CHECK constraint), in the owner's words.
 *
 * "Invited" is not "Sent": the owner cares whether the contractor has engaged,
 * and the four states are exactly the four the column can hold — an unknown
 * value reads as itself rather than as a silent "Invited", so a BE enum widening
 * shows up on screen instead of hiding.
 */
export function recipientBadge(status: RecipientStatus | string): StatusBadge {
  switch (status) {
    case 'invited': return { label: 'Invited', tone: 'quiet' };
    case 'viewed': return { label: 'Viewed', tone: 'live' };
    case 'submitted': return { label: 'Proposal in', tone: 'good' };
    case 'declined': return { label: 'Declined', tone: 'off' };
    default: return { label: String(status), tone: 'quiet' };
  }
}

/**
 * A bid's range as one phrase — "$180,000 – $210,000", or the single figure when
 * the contractor quoted a point rather than a range.
 *
 * Cents in, dollars out, no rounding of our own beyond `money()`: this is a
 * stranger's number being quoted back to the owner, and a range that reads
 * tighter than what was submitted would misdescribe the bid.
 */
export function budgetRange(minCents: number, maxCents: number): string {
  if (!Number.isFinite(minCents) || !Number.isFinite(maxCents)) return '—';
  return minCents === maxCents
    ? dollars(minCents)
    : `${dollars(minCents)} – ${dollars(maxCents)}`;
}

/**
 * Whole dollars, the same shape `lib/format.ts` `money()` prints.
 *
 * Restated here rather than imported on purpose: every node-tested helper module
 * in this app is dependency-free, because the suite runs under
 * `--experimental-strip-types`, which cannot resolve an extensionless `.ts`
 * import — and TypeScript will not let us write the extension under
 * `moduleResolution: bundler`. Keep the two in step; if `money()` ever changes
 * its shape, this changes with it.
 */
function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  })}`;
}

/** "90 days" / "about 3 months" — the duration as a person says it. */
export function timelineWords(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  if (days < 45) return days === 1 ? '1 day' : `${days} days`;
  const months = Math.round(days / 30);
  return `about ${months} months`;
}

/**
 * Why the Send button is off, or null when it is on.
 *
 * The sentence is the button's own explanation — a disabled control with no
 * reason is a dead end, and the three reasons are the three the server will also
 * refuse on (empty brief, nobody to send to, already sent).
 */
export function sendBlockedReason(
  rfp: Pick<RfpView, 'description' | 'status'> | null,
  recipients: readonly RecipientView[],
): string | null {
  if (!rfp) return 'Start the RFP first.';
  if (rfp.status !== 'draft') return 'This RFP has already been sent.';
  if (rfp.description.trim().length === 0) return 'Describe the work before sending it out.';
  if (recipients.length === 0) return 'Add at least one contractor to send it to.';
  return null;
}

/**
 * Proposals newest-submitted first, each carrying the email that sent it.
 *
 * The inbox is read as "who has come back to me", so the recency order is the
 * useful one; the recipient join happens here rather than in the component so
 * the ordering is testable and a proposal whose recipient row is missing still
 * renders (as the company name it carries) instead of throwing.
 */
export interface InboxRow {
  proposal: ProposalView;
  email: string | null;
  selected: boolean;
}

export function inboxRows(view: ProcurementView): InboxRow[] {
  const byId = new Map(view.recipients.map((r) => [r.id, r]));
  return [...view.proposals]
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
    .map((proposal) => ({
      proposal,
      email: byId.get(proposal.rfpRecipientId)?.email ?? null,
      selected: view.selectedProposalId === proposal.id,
    }));
}

/**
 * Should this section offer "Skip to execution"?
 *
 * Persona B — the owner who already has a contractor — never runs an RFP, and
 * ADR-0023 §3 Option B makes skipping the same transition the select-constructor
 * path uses. It is offered only while procurement is still open AND nothing has
 * been sent: skipping after tokens are out would kill live invitations with no
 * warning, so once an RFP is sent the way forward is selecting a proposal.
 */
export function canSkipToExecution(view: ProcurementView): boolean {
  if (view.phase.status !== 'active' && view.phase.status !== 'pending') return false;
  return view.rfp === null || view.rfp.status === 'draft';
}

// ── The calls ────────────────────────────────────────────────────────────────
// All project-scoped under the existing /api/v1 gateway. Colon-suffixed actions
// follow the house convention already in use (`plan-versions:author`).

function base(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/procurement`;
}

/**
 * Turn a refusal into the typed error, with the wording a party should read.
 *
 * The server's codes are the authority on WHAT happened; the sentences are this
 * surface's job. Only the codes this screen can provoke are named — anything
 * else falls back to the server's own message rather than to a guess.
 */
async function refuse(res: Response): Promise<ProcurementError> {
  let payload: unknown = null;
  try { payload = await res.json(); } catch { /* proxy error page */ }
  const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code ?? 'internal';
  const said: Record<string, string> = {
    not_found: 'This project has no procurement phase.',
    not_member: 'You are not on this build, so you cannot run its procurement.',
    unauthenticated: 'Your session has expired. Sign in again to continue.',
    phase_not_active: 'Procurement is closed on this build — a constructor is already chosen.',
    rfp_already_sent: 'This RFP has already gone out. Recipients can be added to a draft only.',
    rfp_empty: 'Describe the work before sending the RFP.',
    no_recipients: 'Add at least one contractor before sending.',
    duplicate_recipient: 'That contractor is already on the list.',
    attachment_too_large: 'That file is over the 10 MB limit.',
    unsupported_content_type: 'That file type is not accepted — images, PDFs and office documents are.',
    already_selected: 'A constructor has already been selected for this build.',
  };
  return new ProcurementError(
    code, said[code] ?? err?.message ?? 'That did not go through. Try again.', res.status,
  );
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refuse(res);
  return (await res.json()) as T;
}

/** GET …/procurement — the phase, the RFP, its recipients and every proposal. */
export async function fetchProcurement(projectId: string): Promise<ProcurementView> {
  return json<ProcurementView>(await fetch(base(projectId), { cache: 'no-store' }));
}

/**
 * PUT …/procurement/rfp — create the draft, or save the one that exists.
 *
 * One idempotent write for both: "start an RFP" and "keep typing" are the same
 * intent, and a separate create would leave a half-made row behind every time
 * someone opened the composer and changed their mind.
 */
export async function saveRfpDraft(
  projectId: string,
  draft: { description: string; specialties: string[] },
): Promise<RfpView> {
  const res = await fetch(`${base(projectId)}/rfp`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  return (await json<{ rfp: RfpView }>(res)).rfp;
}

/**
 * POST …/rfp/attachments — one drawing, survey or photo onto the brief.
 *
 * Multipart with a single `file` part and nothing else: the declared type, the
 * size and the uploader are all re-derived server-side (R2, ADR-0021), and
 * sending our copy would only create something for the two to disagree about.
 */
export async function uploadRfpAttachment(projectId: string, file: File): Promise<FileRef> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${base(projectId)}/rfp/attachments`, { method: 'POST', body: form });
  return (await json<{ attachment: FileRef }>(res)).attachment;
}

/** POST …/rfp/recipients — add one address or a whole pasted column. */
export async function addRecipients(
  projectId: string, emails: string[],
): Promise<RecipientView[]> {
  const res = await fetch(`${base(projectId)}/rfp/recipients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emails }),
  });
  return (await json<{ recipients: RecipientView[] }>(res)).recipients;
}

/** DELETE …/rfp/recipients/:id — take a name off, while the RFP is still a draft. */
export async function removeRecipient(projectId: string, recipientId: string): Promise<void> {
  const res = await fetch(
    `${base(projectId)}/rfp/recipients/${encodeURIComponent(recipientId)}`, { method: 'DELETE' },
  );
  if (!res.ok) throw await refuse(res);
}

/**
 * POST …/rfp:send — mint a token per recipient and email the invitations.
 *
 * The one-way door. After this the brief is frozen and the tokens are live until
 * the procurement phase closes (ADR §5) — which is why the button that calls it
 * asks first.
 */
export async function sendRfp(projectId: string): Promise<ProcurementView> {
  const res = await fetch(`${base(projectId)}/rfp:send`, { method: 'POST' });
  return json<ProcurementView>(res);
}

/**
 * POST …/proposals/:id:select — choose the constructor (LINA-280).
 *
 * Activating execution is what kills every outstanding RFP token, so this is the
 * call that ends procurement. The losing proposals stay on the record.
 */
export async function selectProposal(
  projectId: string, proposalId: string,
): Promise<ProcurementView> {
  const res = await fetch(
    `${base(projectId)}/proposals/${encodeURIComponent(proposalId)}:select`, { method: 'POST' },
  );
  return json<ProcurementView>(res);
}

/** POST …/procurement:skip — Persona B's door: no RFP, straight to execution. */
export async function skipProcurement(projectId: string): Promise<ProcurementView> {
  return json<ProcurementView>(await fetch(`${base(projectId)}:skip`, { method: 'POST' }));
}
