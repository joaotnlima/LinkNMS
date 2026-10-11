// Pure view model for PRD-04 — the RFP and the directory, both doors (D-47):
// bidders tagged by source, suggested companies with proof lines, requests to
// bid, "Ask for a proposal" from a profile, and the company inbox. No I/O: the
// server decides who matches, who ranks and what may be decided; this file
// only words and orders what it answered. I/O lives in `./rfp-directory.ts`
// (issuer side) and `./company-inbox.ts` (company side).

import type { V2DirectoryCard } from './directory-view.ts';
import type { RecipientSource, RfpStatus, V2Recipient } from './tendering-view.ts';

// ── wire (api/v2 components/schemas) ─────────────────────────────────────────

/** #/components/schemas/CompanyProof */
export interface V2CompanyProof {
  org_id: string;
  display_name: string;
  slug?: string;
  claimed: boolean;
  verified_clients: number;
  builds: number;
  tasks_finished: number;
  tasks_on_time: number;
  distance_km?: number;
}

/** #/components/schemas/BidRequest */
export interface V2BidRequest {
  id: string;
  rfp_id: string;
  org_id: string;
  status: 'pending' | 'approved' | 'declined';
  requested_at: string;
  decided_at?: string | null;
  recipient_id?: string;
  company?: V2CompanyProof;
}

/** #/components/schemas/CompanyRequest — "Requests for you". */
export interface V2CompanyRequest {
  rfp_id: string;
  recipient_id: string;
  title: string;
  origin: RecipientSource;
  issuer_level: 'owner' | 'sub';
  build?: { name: string; municipality_code?: string };
  rfp_status: RfpStatus;
  submission_deadline: string;
  task_count: number;
  file_count: number;
  invitation_status: string;
  proposal_id?: string;
  proposal_status?: string;
  awarded_to_me?: boolean;
  received_at?: string;
}

/** #/components/schemas/OpenRequest — "Open requests near you". */
export interface V2OpenRequest {
  rfp_id: string;
  title: string;
  issuer_level: 'owner' | 'sub';
  build?: { name: string; municipality_code?: string };
  distance_km?: number;
  specialty_codes: string[];
  submission_deadline: string;
  task_count: number;
  my_request?: V2BidRequest;
}

export type Tone = 'quiet' | 'live' | 'good' | 'warn' | 'off';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function km(n: number): string {
  return n < 10 ? `${n.toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(n)} km`;
}

// ── bidders tagged by source (X-4, X-5) ──────────────────────────────────────

export function sourceTag(source: RecipientSource | undefined): { label: string; tone: Tone } {
  if (source === 'directory') return { label: 'Directory', tone: 'live' };
  if (source === 'asked_to_bid') return { label: 'Asked to bid', tone: 'good' };
  return { label: 'Email', tone: 'quiet' };
}

/** The name a bidder row shows: the directory name, else the address. */
export function recipientName(r: Pick<V2Recipient, 'company_name' | 'email'>): string {
  return r.company_name?.trim() || r.email;
}

/** "unclaimed profile" / "not on LinkNMS yet" — only for a bidder with no organisation. */
export function recipientNote(r: Pick<V2Recipient, 'source' | 'org_id'>): string | null {
  if (r.org_id) return null;
  return r.source === 'directory' ? 'unclaimed profile' : 'not on LinkNMS yet';
}

/** "4 · 3 from the directory · 1 by email" — the Bidders step's summary. */
export function biddersSummary(recipients: readonly Pick<V2Recipient, 'source'>[]): string {
  if (!recipients.length) return 'none yet';
  const count = (s: RecipientSource) => recipients.filter((r) => (r.source ?? 'email') === s).length;
  const parts = [String(recipients.length)];
  if (count('directory')) parts.push(`${count('directory')} from the directory`);
  if (count('email')) parts.push(`${count('email')} by email`);
  if (count('asked_to_bid')) parts.push(`${count('asked_to_bid')} asked to bid`);
  return parts.join(' · ');
}

/** Address-only invitees: the ones who get an unclaimed profile when the RFP is sent (X-2). */
export function emailInviteeCount(recipients: readonly Pick<V2Recipient, 'source' | 'org_id'>[]): number {
  return recipients.filter((r) => (r.source ?? 'email') === 'email' && !r.org_id).length;
}

// ── suggested companies (X-1) ────────────────────────────────────────────────

/** Already on the list? A claimed company by its organisation, an unclaimed one by its directory name. */
export function isSuggestionAdded(card: Pick<V2DirectoryCard, 'org_id' | 'display_name' | 'claimed'>,
  recipients: readonly Pick<V2Recipient, 'org_id' | 'company_name' | 'source'>[]): boolean {
  return recipients.some((r) => (card.claimed && r.org_id === card.org_id)
    || (!card.claimed && r.source === 'directory' && !r.org_id && r.company_name === card.display_name));
}

/** "6 km · Verified · 4 builds · 6 of 7 tasks on the planned date" / "14 km · unclaimed · No profile details yet". */
export function suggestionLine(card: Pick<V2DirectoryCard, 'distance_km' | 'claimed' | 'record'>): { tag: string; text: string } {
  const where = card.distance_km != null ? `${km(card.distance_km)} · ` : '';
  const r = card.record;
  if (r.ranked) {
    const tasks = r.tasks_finished ? ` · ${r.tasks_on_time} of ${r.tasks_finished} tasks on the planned date` : '';
    return { tag: 'Verified', text: `${where}${plural(r.builds, 'build', 'builds')}${tasks}` };
  }
  if (!card.claimed) return { tag: 'Stated', text: `${where}unclaimed · No profile details yet` };
  return { tag: 'Stated', text: `${where}No builds on LinkNMS yet` };
}

/** The proof line of a company asking to bid (X-5), from its CompanyProof. */
export function proofLine(p: V2CompanyProof): { tag: 'Verified' | 'Stated'; text: string } {
  const away = p.distance_km != null ? ` · ${km(p.distance_km)} away` : '';
  if (p.verified_clients > 0) {
    const tasks = p.tasks_finished ? ` · ${p.tasks_on_time} of ${p.tasks_finished} tasks on the planned date` : '';
    return { tag: 'Verified', text: `${plural(p.builds, 'build', 'builds')} on LinkNMS${tasks}${away}` };
  }
  return { tag: 'Stated', text: `No builds on LinkNMS yet${away}${p.claimed ? '' : ' · unclaimed profile'}` };
}

/** Only an in-app plan path may be a return target (no open redirect). */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  if (!/^\/projects\/[0-9a-f-]{36}\/plan(\?[\w=&%.-]*)?$/i.test(raw)) return null;
  return raw;
}

/** The plan with the task's Tender tab open — where the directory returns to. */
export function tenderPanelHref(projectId: string, taskId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan?task=${encodeURIComponent(taskId)}&tab=tender`;
}

/** D1 prefilled from the task (X-1): its specialty, near its build, adding to this RFP, back to the panel. */
export function directoryHref(input: {
  projectId: string; taskId: string; rfpId: string; specialtyCode?: string | null;
}): string {
  const usp = new URLSearchParams();
  if (input.specialtyCode) usp.set('specialty', input.specialtyCode);
  usp.set('near_project', input.projectId);
  usp.set('for_rfp', input.rfpId);
  usp.set('return_to', tenderPanelHref(input.projectId, input.taskId));
  return `/companies?${usp.toString()}`;
}

// ── asking to bid (X-5) ──────────────────────────────────────────────────────

export function bidRequestBadge(status: V2BidRequest['status']): { label: string; tone: Tone } {
  if (status === 'approved') return { label: 'Approved — link sent', tone: 'good' };
  if (status === 'declined') return { label: 'Declined', tone: 'off' };
  return { label: 'Asked to bid', tone: 'warn' };
}

export function pendingFirst(items: readonly V2BidRequest[]): V2BidRequest[] {
  return [...items].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')
    || String(b.requested_at).localeCompare(String(a.requested_at)));
}

// ── Ask for a proposal, from a profile (X-6, X-7) ────────────────────────────

/**
 * #/components/schemas/AskCandidate — one task of a build as "Ask for a
 * proposal" offers it to a company (X-6, X-7). The ranking, the specialty
 * match and the target are the server's (listAskCandidates).
 */
export interface AskTask {
  task_id: string;
  code?: string;
  name: string;
  specialty_code?: string | null;
  specialty_match: boolean;
  /** The RFP that governs the task now, if any. */
  rfp?: { id: string; title: string; status: RfpStatus; invited_count?: number } | null;
  /** Where the company lands: the draft, a new draft, or nothing (out for bids). */
  target: { kind: 'draft'; rfp_id: string } | { kind: 'new' } | { kind: 'locked'; reason: string };
}

// ── the company inbox (X-9, X-10) ────────────────────────────────────────────

const ORIGIN: Record<RecipientSource, string> = {
  directory: 'found you in the directory',
  email: 'invited by email',
  asked_to_bid: 'you asked to bid',
};

/** "From the owner · found you in the directory · bids due 20 Jan 2027 · 9 tasks · 1 file" */
export function originLine(r: V2CompanyRequest): string {
  const bits = [
    r.issuer_level === 'owner' ? 'From the owner' : 'From a general contractor',
    ORIGIN[r.origin] ?? ORIGIN.email,
    `bids due ${day(r.submission_deadline)}`,
    plural(r.task_count, 'task', 'tasks'),
  ];
  if (r.file_count) bits.push(plural(r.file_count, 'file', 'files'));
  return bits.join(' · ');
}

/** The badge of one request for you, and whether it can still be priced or declined. */
export function requestState(r: V2CompanyRequest): { label: string; tone: Tone; canPrice: boolean; canDecline: boolean } {
  if (r.awarded_to_me) return { label: '✓ Awarded', tone: 'good', canPrice: false, canDecline: false };
  if (r.rfp_status === 'cancelled') return { label: 'Cancelled', tone: 'off', canPrice: false, canDecline: false };
  if (r.invitation_status === 'declined') return { label: 'Declined', tone: 'off', canPrice: false, canDecline: false };
  if (r.rfp_status === 'awarded') return { label: 'Not chosen', tone: 'off', canPrice: false, canDecline: false };
  const untouched = !r.proposal_status || r.proposal_status === 'invited' || r.proposal_status === 'draft';
  if (!untouched) return { label: 'Proposal sent', tone: 'live', canPrice: r.rfp_status === 'published', canDecline: false };
  if (r.rfp_status !== 'published') return { label: 'Bidding closed', tone: 'off', canPrice: false, canDecline: false };
  const fresh = r.invitation_status === 'queued' || r.invitation_status === 'sent';
  return { label: fresh ? 'New' : 'Opened', tone: fresh ? 'warn' : 'quiet', canPrice: true, canDecline: true };
}

/** "Casa da Encosta · 6 km · bids due 20 Jan 2027 · 9 tasks" */
export function openRequestLine(o: V2OpenRequest): string {
  const bits: string[] = [];
  if (o.build?.name) bits.push(o.build.name);
  if (o.distance_km != null) bits.push(`${km(o.distance_km)} away`);
  bits.push(o.issuer_level === 'owner' ? 'from the owner' : 'from a general contractor');
  bits.push(`bids due ${day(o.submission_deadline)}`);
  bits.push(plural(o.task_count, 'task', 'tasks'));
  return bits.join(' · ');
}

/** What the company can do on an open request: ask, or see its request's state. */
export function openRequestAction(o: V2OpenRequest): { kind: 'ask' } | { kind: 'state'; label: string; tone: Tone; open: boolean } {
  const r = o.my_request;
  if (!r) return { kind: 'ask' };
  if (r.status === 'approved') return { kind: 'state', label: 'Approved — price it', tone: 'good', open: true };
  if (r.status === 'declined') return { kind: 'state', label: 'Declined by the issuer', tone: 'off', open: false };
  return { kind: 'state', label: 'Asked — waiting for the owner', tone: 'warn', open: false };
}

export type InboxTab = 'for-you' | 'near';
export function inboxTab(raw: string | string[] | undefined): InboxTab {
  return (Array.isArray(raw) ? raw[0] : raw) === 'near' ? 'near' : 'for-you';
}
