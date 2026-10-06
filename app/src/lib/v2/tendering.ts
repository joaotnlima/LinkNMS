// The tendering surface's data layer, on `/api/v2` (LINA-361, S5 of the UI
// cutover, doc 22 §3). Mirrors S1/S2 (`profile.ts`/`record.ts`): this module is
// ONLY the I/O and the fail-closed error handling; the pure wire→view transforms
// live in `./tendering-view.ts` so they stay unit-testable without a session.
//
// It replaces the v1 procurement client (`lib/procurement.ts`), which talked to
// the schedule service under `/api/v1` and modelled one flat RFP per procurement
// phase. Every call here goes through the single shared v2 seam
// (`./client.ts::v2`) — there is deliberately NO second client (LINA-309).
//
// ── THE TWO FIRST-CLASS EMPTY STATES (issue requirement) ─────────────────────
//  • Signed in, no active org — a person with no organisation selected. v2's
//    tendering reads require an active org (doc 16 §4); with none, `getMyRfps`
//    returns [] and the surface renders its neutral "pick an organisation" state
//    rather than crashing. We skip the org-required read entirely in that case,
//    the same shortcut `profile.ts::listPortfolio` takes.
//  • Empty reads — a viewer with an org but no RFPs, or an RFP with no proposals
//    yet, is not an error: the reads return [] / a lane-less inbox and the
//    surface says so.
//
// Fail-closed exactly as S1/S2: a `V2Error` on a read (not a participant, denied,
// not mirrored) resolves to the empty shape, never a rendered 500 and never a
// leak. Writes DO surface their `V2Error` — a refused create/publish/award is an
// answer the composer must show, not swallow.
import 'server-only';
import { randomUUID } from 'node:crypto';

import type { ProcurementRfp } from '../plan-gantt';
import { v2, V2Error } from './client';
import type { V2Me } from './profile-view';
import type {
  V2Rfp, V2Recipient, V2ProposalLane, V2Comparison, RfpDraftInput, RfpVisibility,
  V2Money, V2ProposalDetail, V2ProposalDocument,
  RfpStatus, ProposalStatus,
} from './tendering-view';
import type { V2UploadTicket } from './task-workspace-view';

// ── Reads: the composer's own RFPs ───────────────────────────────────────────

interface ListBody<T> { items: T[]; next_cursor?: string | null }

/**
 * GET /me/rfps → the RFPs this org issues, newest server-order first. Returns []
 * for a viewer with no active org (nothing to scope to) or any V2Error — the
 * B2 empty-portal posture: an honest empty inbox, never a crash.
 */
export async function getMyRfps(): Promise<V2Rfp[]> {
  const me = await v2<V2Me>({ method: 'GET', path: '/me' }).catch(() => null);
  if (!me?.active_org) return []; // no org → nothing to scope RFPs to
  try {
    const list = await v2<ListBody<V2Rfp>>({ method: 'GET', path: '/me/rfps' });
    return list.items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

/**
 * GET /rfps/{rfpId} → the full RFP including its packaged BoQ, or null when the
 * viewer cannot see it (not the issuer, not mirrored, gone). Null is the
 * page's "no such RFP for you" state, never a leak of existence.
 */
export async function getRfp(rfpId: string): Promise<V2Rfp | null> {
  try {
    return await v2<V2Rfp>({ method: 'GET', path: `/rfps/${encodeURIComponent(rfpId)}` });
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

/** GET /rfps/{rfpId}/recipients → the issuer's recipient list (never bidders). */
export async function listRecipients(rfpId: string): Promise<V2Recipient[]> {
  try {
    const list = await v2<ListBody<V2Recipient>>({
      method: 'GET', path: `/rfps/${encodeURIComponent(rfpId)}/recipients`,
    });
    return list.items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

// ── Reads: the proposals inbox ───────────────────────────────────────────────

/**
 * The inbox read, money-gate aware. The issuer who can see money gets the full
 * comparison matrix (lanes + per-row prices + medians, GET /rfps/{id}/comparison
 * — itself behind `org:money:view`). An issuer WITHOUT money cannot call it
 * (403), so we fall back to the per-task lane reads (`/tasks/{id}/proposal-lanes`
 * over the RFP's root tasks), which carry no prices — a first-class, honest
 * "you can compare who bid, not for how much" state rather than a dead screen.
 */
export interface Inbox {
  lanes: V2ProposalLane[];
  /** Present only for a viewer with `org:money:view`. */
  comparison: V2Comparison | null;
  seesMoney: boolean;
}

export async function getInbox(rfp: Pick<V2Rfp, 'id' | 'root_task_ids'>): Promise<Inbox> {
  // The lane list is ALWAYS the per-task read, for every viewer: it carries the
  // full set of proposals — including the `invited` lanes a bid has not yet
  // landed on — which `/comparison` omits (it filters to submitted+). The inbox
  // needs those invited lanes to offer "record an emailed bid" against them, and
  // for a money-viewer the per-task read still carries `total` (LINA-372). The
  // comparison call is then only the money-gated per-line matrix.
  const lanes = await gatherLanes(rfp.root_task_ids);
  try {
    const cmp = await v2<V2Comparison>({
      method: 'GET', path: `/rfps/${encodeURIComponent(rfp.id)}/comparison`,
    });
    return { lanes, comparison: cmp, seesMoney: true };
  } catch (err) {
    // 403 = money gate (or not the issuer). Keep the price-free lanes; any other
    // V2Error is fail-closed to an empty inbox.
    if (err instanceof V2Error && err.status === 403) {
      return { lanes, comparison: null, seesMoney: false };
    }
    if (err instanceof V2Error) return { lanes: [], comparison: null, seesMoney: false };
    throw err;
  }
}

/**
 * Lanes across an RFP's tendered tasks, de-duplicated by proposal — the
 * money-less inbox's read. A per-task read that denies (a task the viewer is not
 * on) contributes nothing rather than failing the whole inbox.
 */
async function gatherLanes(rootTaskIds: readonly string[]): Promise<V2ProposalLane[]> {
  const perTask = await Promise.all(rootTaskIds.map(async (taskId) => {
    try {
      const list = await v2<ListBody<V2ProposalLane>>({
        method: 'GET', path: `/tasks/${encodeURIComponent(taskId)}/proposal-lanes`,
      });
      return list.items ?? [];
    } catch (err) {
      if (err instanceof V2Error) return [];
      throw err;
    }
  }));
  const byProposal = new Map<string, V2ProposalLane>();
  for (const lane of perTask.flat()) {
    if (!byProposal.has(lane.proposal_id)) byProposal.set(lane.proposal_id, lane);
  }
  return [...byProposal.values()];
}

// ── Reads: the Compare drill-down (LINA-411) ──────────────────────────────────
// Post-shortlist the issuer compares the bids side by side. A DETAILED tender
// uses the money-gated per-line matrix already in the inbox; a LIGHT tender
// (design/pre-construction, a fee not a BoQ) has no lines to tabulate, so the
// Docs renderer reads each bidder's full answer — its references, notes and the
// portfolio PDFs it attached. Both reads fail CLOSED (a proposal the viewer
// cannot see contributes nothing), never a rendered 500.

/** A bidder's full answer + its portfolio attachments, for the Docs renderer. */
export interface CompareEntry {
  detail: V2ProposalDetail;
  documents: V2ProposalDocument[];
}

interface ProposalWire {
  id: string;
  summary?: { total?: V2Money; duration_wd?: number; start?: string };
  conditions?: string;
  validity_until?: string;
  reference_notes?: string;
  document_ids?: string[];
}

/**
 * GET /proposals/{proposalId} → the bidder's answer (issuer or author). `total`
 * is ABSENT without `org:money:view` (wire invariant §6.5), which `formatMoney`
 * renders as "—". Null when the viewer cannot see it, never a leak of existence.
 */
export async function getProposalDetail(proposalId: string): Promise<V2ProposalDetail | null> {
  try {
    const p = await v2<ProposalWire>({ method: 'GET', path: `/proposals/${encodeURIComponent(proposalId)}` });
    return {
      proposal_id: p.id,
      ...(p.reference_notes ? { reference_notes: p.reference_notes } : {}),
      ...(p.conditions ? { conditions: p.conditions } : {}),
      ...(p.validity_until ? { validity_until: p.validity_until } : {}),
      ...(p.summary?.total ? { total: p.summary.total } : {}),
      ...(p.summary?.duration_wd != null ? { duration_wd: p.summary.duration_wd } : {}),
      ...(p.summary?.start ? { start: p.summary.start } : {}),
      document_ids: p.document_ids ?? [],
    };
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

/**
 * A proposal's portfolio attachments for the Docs renderer, derived from the
 * proposal's own `document_ids`.
 *
 * WHY NOT A DOCUMENTS LIST CALL: proposal attachments live in
 * `tendering.proposal_document`, NOT the documents module, and the only route
 * over them is the per-file download (`…/documents/{id}:download`, issuer|author
 * gated). There is no issuer-side list-with-names endpoint, so the file's own
 * name is not on the wire here; each attachment is shown as a numbered portfolio
 * link and the download response carries the real filename (Content-Disposition).
 * `getProposal` already returns `document_ids` filtered to what the viewer may
 * see, so this needs no extra read and inherits that gate.
 */
function portfolioOf(detail: V2ProposalDetail): V2ProposalDocument[] {
  return detail.document_ids.map((id, i) => ({ id, title: `Portfolio file ${i + 1}` }));
}

/** The Docs renderer's read: each compared proposal's detail + its portfolio. */
export async function getCompareEntries(proposalIds: readonly string[]): Promise<CompareEntry[]> {
  const entries = await Promise.all(proposalIds.map(async (id) => {
    const detail = await getProposalDetail(id);
    return detail ? { detail, documents: portfolioOf(detail) } : null;
  }));
  return entries.filter((e): e is CompareEntry => e !== null);
}

// ── The tendering ⇄ schedule bridge: procurement windows (LINA-413) ──────────
// The plan's Gantt paints a procurement window on a tendered task's bar — the
// stretch of calendar spent choosing a contractor before the work can begin.
// This is the READ that feeds it: for every root task of the project's live
// tenders, the RFP facts the bar needs (status, when it opened, when bids are
// due, how many have landed). PRIMITIVES ONLY — no write-back of a date.

/** The `rfp` block `GET /tasks/{id}/proposal-lanes` carries (RfpWindow). */
interface RfpWindowWire {
  id: string;
  status: RfpStatus;
  opened_at?: string;
  submission_deadline: string;
  awarded_proposal_id?: string;
}

/** A proposal-lanes read with its governing-RFP block (LINA-413). */
interface LanesWithRfp extends ListBody<V2ProposalLane> {
  rfp?: RfpWindowWire | null;
}

/** A lane counts as a landed bid — what turns "tendering" into "bids in". */
function isLandedBid(status: ProposalStatus): boolean {
  return status === 'submitted' || status === 'shortlisted' || status === 'awarded';
}

/**
 * Every tendered task of a project, mapped to the procurement window its Gantt
 * bar paints (LINA-413), keyed by task id (= the plan row's stable key in v2).
 *
 * Scope is the ISSUER's own tenders (`getMyRfps`), filtered to this project and
 * excluding cancelled ones — which is exactly who the plan editor serves (the GC
 * authoring the plan is the tender's issuer; a bidder never sees the editor). We
 * discover WHICH tasks are out to tender from the RFP list, then read each root
 * task's lanes to get the `rfp` block (its `opened_at`, the draft's creation) and
 * count the bids that have landed. One read per tendered task, in parallel; a
 * denied/absent read drops that task silently rather than failing the plan.
 *
 * Fail-closed like every read here: no active org, no tenders, or any V2Error →
 * an empty map, never a crash and never a leak.
 */
export async function getProcurementWindows(
  projectId: string,
): Promise<Record<string, ProcurementRfp>> {
  const rfps = (await getMyRfps()).filter(
    (r) => r.project_id === projectId && r.status !== 'cancelled',
  );
  // The union of root tasks across the project's live tenders — one read each.
  const taskIds = [...new Set(rfps.flatMap((r) => r.root_task_ids))];
  if (taskIds.length === 0) return {};

  const windows: Record<string, ProcurementRfp> = {};
  await Promise.all(taskIds.map(async (taskId) => {
    try {
      const res = await v2<LanesWithRfp>({
        method: 'GET', path: `/tasks/${encodeURIComponent(taskId)}/proposal-lanes`,
      });
      const rfp = res.rfp;
      if (!rfp?.opened_at) return; // no live tender on this row (or pre-LINA-413 store)
      windows[taskId] = {
        status: rfp.status,
        openedDay: rfp.opened_at.slice(0, 10),
        bidsDueDay: rfp.submission_deadline.slice(0, 10),
        submittedCount: (res.items ?? []).filter((l) => isLandedBid(l.status)).length,
      };
    } catch (err) {
      if (err instanceof V2Error) return;
      throw err;
    }
  }));
  return windows;
}

// ── Writes: the composer ─────────────────────────────────────────────────────
// A refused write surfaces its `V2Error` — the composer shows the reason
// (validation_failed carries field errors; forbidden carries a role/relationship
// reason). Only the id is minted here; the acting org and the RFP level are
// decided server-side from the session, never sent (the actor is never in the
// body — the v1 rule this preserves).

/**
 * POST /projects/{projectId}/rfps — create the draft over the chosen tasks.
 *
 * The `id` is a client-generated UUID the create handler dedupes on (it doubles
 * as the Idempotency-Key), so a double-submit yields one RFP. Specialties and
 * the packaged BoQ are derived server-side from `root_task_ids`; they are not in
 * the body. Returns the stored RFP (its id is the caller's own, echoed back).
 */
export async function createRfp(projectId: string, draft: RfpDraftInput): Promise<V2Rfp> {
  const id = randomUUID();
  return v2<V2Rfp>({
    method: 'POST',
    path: `/projects/${encodeURIComponent(projectId)}/rfps`,
    idempotencyKey: id,
    body: {
      id,
      root_task_ids: draft.rootTaskIds,
      title: draft.title.trim(),
      ...(draft.scopeText.trim() ? { scope_text: draft.scopeText.trim() } : {}),
      visibility: draft.visibility,
      ...(draft.purpose ? { purpose: draft.purpose } : {}),
      ...(draft.mode ? { mode: draft.mode } : {}),
      ...(draft.questionsDeadline ? { questions_deadline: draft.questionsDeadline } : {}),
      submission_deadline: draft.submissionDeadline,
    },
  });
}

/**
 * PATCH /rfps/{rfpId} — edit a draft's title/scope/deadlines/visibility. The
 * `version` becomes the `If-Match` the handler uses for optimistic concurrency;
 * a stale version is a 409 the caller re-reads on. Only a draft is editable.
 */
export interface RfpPatch {
  title?: string;
  scopeText?: string;
  questionsDeadline?: string | null;
  submissionDeadline?: string;
  visibility?: RfpVisibility;
}

export async function updateRfp(rfpId: string, patch: RfpPatch, version: number): Promise<V2Rfp> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title.trim();
  if (patch.scopeText !== undefined) body.scope_text = patch.scopeText.trim();
  if (patch.questionsDeadline !== undefined) body.questions_deadline = patch.questionsDeadline;
  if (patch.submissionDeadline !== undefined) body.submission_deadline = patch.submissionDeadline;
  if (patch.visibility !== undefined) body.visibility = patch.visibility;
  return v2<V2Rfp>({
    method: 'PATCH',
    path: `/rfps/${encodeURIComponent(rfpId)}`,
    body: { ...body, version },
  });
}

/**
 * POST /rfps/{rfpId}/recipients — invite one address or a whole pasted column.
 *
 * The 201 carries each recipient's raw personal-link `token` ONCE (email
 * delivery is a later module — same rationale as ProjectInvitation.token), so
 * the composer can show/copy the link. The server re-derives status; we send
 * only the emails.
 */
export async function addRecipients(rfpId: string, emails: string[]): Promise<V2Recipient[]> {
  const res = await v2<{ items?: V2Recipient[] } | V2Recipient[]>({
    method: 'POST',
    path: `/rfps/${encodeURIComponent(rfpId)}/recipients`,
    body: { recipients: emails.map((email) => ({ email })) },
  });
  return Array.isArray(res) ? res : (res.items ?? []);
}

/** POST /rfps/{rfpId}:publish — the one-way door: draft → published, tokens live. */
export async function publishRfp(rfpId: string): Promise<V2Rfp> {
  return v2<V2Rfp>({ method: 'POST', path: `/rfps/${encodeURIComponent(rfpId)}:publish` });
}

/** POST /rfps/{rfpId}:close — stop receiving proposals, ahead of awarding. */
export async function closeRfp(rfpId: string): Promise<V2Rfp> {
  return v2<V2Rfp>({ method: 'POST', path: `/rfps/${encodeURIComponent(rfpId)}:close` });
}

/** POST /rfps/{rfpId}:cancel — abandon the tender (draft/published/closed). */
export async function cancelRfp(rfpId: string): Promise<V2Rfp> {
  return v2<V2Rfp>({ method: 'POST', path: `/rfps/${encodeURIComponent(rfpId)}:cancel` });
}

// ── Writes: the inbox / evaluation ───────────────────────────────────────────

/** POST /proposals/{proposalId}:shortlist — submitted → shortlisted (issuer). */
export async function shortlistProposal(proposalId: string): Promise<void> {
  await v2<unknown>({ method: 'POST', path: `/proposals/${encodeURIComponent(proposalId)}:shortlist` });
}

/**
 * POST /rfps/{rfpId}:award — choose the winner. Human-only, and the contract
 * draft is written in the same transaction (awarded can never exist without its
 * contract). Every other live lane is declined. Returns the awarded RFP.
 */
export async function awardRfp(rfpId: string, proposalId: string): Promise<V2Rfp> {
  return v2<V2Rfp>({
    method: 'POST',
    path: `/rfps/${encodeURIComponent(rfpId)}:award`,
    body: { proposal_id: proposalId },
  });
}

/**
 * POST /proposals/{proposalId}:record-offline — the issuer types in a bid that
 * arrived by email (PDFs + a total + a duration), so an off-platform contractor
 * still sits in the comparison. `total` is integer cents on the wire.
 */
export interface OfflineProposalInput {
  documentIds: string[];
  totalCents: number;
  durationWd?: number;
  start?: string;
  conditions?: string;
  validityUntil?: string;
}

export async function recordOfflineProposal(proposalId: string, offline: OfflineProposalInput): Promise<void> {
  await v2<unknown>({
    method: 'POST',
    path: `/proposals/${encodeURIComponent(proposalId)}:record-offline`,
    body: {
      document_ids: offline.documentIds,
      total: { amount_cents: offline.totalCents, currency: 'EUR' },
      ...(offline.durationWd !== undefined ? { duration_wd: offline.durationWd } : {}),
      ...(offline.start ? { start: offline.start } : {}),
      ...(offline.conditions ? { conditions: offline.conditions } : {}),
      ...(offline.validityUntil ? { validity_until: offline.validityUntil } : {}),
    },
  });
}

// ── Writes: recorded-offline proposal documents (R2, doc scope `proposal`) ─────
// The emailed bid a `:record-offline` references carries the bidder's PDFs. They
// are real documents in the documents module (SCOPE_TYPES includes `proposal`;
// `canEditScope` grants the RFP issuer write on a proposal it owns), reserved and
// completed through the SAME reserve → browser-PUT → complete protocol the task
// workspace uses (`task-workspace.ts`), scoped to the proposal instead of a task.
// Reserve and complete run server-side (they call `/api/v2`); the browser only
// does the presigned PUT (`upload-client.ts`). The document `id` is minted here
// so the caller holds it before the bytes land — it is what `:record-offline`
// then lists in `document_ids`.

/** A reserved proposal-document upload: its id, the version to complete, the PUT. */
export interface ProposalUploadTicket {
  documentId: string;
  versionRef: string;
  uploadUrl: string;
  expiresAt: string;
}

/**
 * Step 1: reserve a `proposal`-scoped document (its first version) and get a
 * presigned PUT ticket. The declared sha256 is pinned into the signature, so the
 * browser cannot upload bytes other than the ones it declared. The minted `id`
 * doubles as the idempotency key AND is the document id `:record-offline` will
 * reference.
 */
export async function reserveProposalDocument(
  proposalId: string,
  file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<ProposalUploadTicket> {
  const id = randomUUID();
  const ticket = await v2<V2UploadTicket>({
    method: 'POST',
    path: '/documents',
    idempotencyKey: id,
    body: {
      id,
      scope_type: 'proposal',
      scope_id: proposalId,
      kind: 'other',
      title: file.name,
      file: {
        name: file.name,
        mime: file.mime,
        size_bytes: file.sizeBytes,
        sha256: file.sha256.toLowerCase(),
      },
    },
  });
  return {
    documentId: id,
    versionRef: ticket.document_version_id,
    uploadUrl: ticket.upload_url,
    expiresAt: ticket.expires_at,
  };
}

/** Step 3 (step 2 is the browser PUT): prove the bytes landed and finalise it. */
export async function completeProposalDocument(versionRef: string): Promise<void> {
  await v2<unknown>({
    method: 'POST',
    path: `/document-versions/${encodeURIComponent(versionRef)}:complete`,
  });
}
