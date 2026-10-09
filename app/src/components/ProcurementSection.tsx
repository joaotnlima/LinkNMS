'use client';

// The tendering section — the RFP composer and the proposals inbox, on `/api/v2`
// (LINA-361, S5 of the UI cutover). It renders inside the Procurement accordion
// of `/projects/:id/plan` (ADR-0023 §4/§6; the shell is LINA-281), so it owns no
// heading chrome, no route and no page frame: it is a section body.
//
// This replaces the v1 surface that talked to the schedule service through
// `lib/procurement.ts`. v2 tendering is org-centric and richer: an RFP is raised
// over chosen plan tasks (a packaged BoQ), bidders answer in LANES, and the
// issuer compares (money-gated) and awards — which writes the winner's contract
// in the same transaction. Every read/write goes through the server actions in
// `./procurement-actions.ts`, which funnel to the ONE shared v2 client — the
// browser never mints its own (LINA-309).
//
// ── WHAT THIS SURFACE PROMISES ───────────────────────────────────────────────
// 1. PUBLISH IS A DOOR, AND IT IS DRAWN AS ONE. Publishing mints a live personal
//    link per recipient; it confirms first and says how many it is about to
//    write to.
// 2. A DRAFT IS PRIVATE UNTIL PUBLISHED. No token exists yet, and the composer
//    says so.
// 3. MONEY MAY BE WITHHELD, AND THE SURFACE SAYS SO. A viewer without
//    `org:money:view` sees the lanes and who bid, but every figure reads "—" and
//    the comparison matrix is replaced with an honest note — never a fake €0.
// 4. AWARD IS ONE-WAY AND EXPLAINS ITSELF. It confirms, names the winner, and
//    when it is off it carries its own reason (RFP not closed, bidder has no org,
//    nothing picked).
// 5. NOTHING IS COMPUTED FROM A BID. Totals, medians and per-line prices are the
//    server's comparison projection; this surface formats them, never derives a
//    ranking.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  loadMyRfpsAction, loadComposerAction, loadInboxAction, loadCompareAction,
  createRfpAction, updateRfpAction, addRecipientsAction, publishRfpAction,
  closeRfpAction, shortlistAction, awardAction, recordOfflineAction,
  reserveProposalDocumentAction, completeProposalDocumentAction,
  type ComposerData,
} from './procurement-actions';
import {
  formatMoney, leadTimeWeeks, rfpStatusBadge, proposalStatusBadge, recipientStatusBadge,
  parseRecipients, createBlockedReason, publishBlockedReason,
  orderLanes, isLive, awardBlockedReason, packageSpecialties, eurosToCents,
  compareRenderer, shortlistedLanes, compareBlockedReason,
  serializeCompareIds, parseCompareIds, proposalDocumentDownloadPath,
  type V2Rfp, type V2Recipient, type V2ProposalLane, type V2Comparison,
  type RfpVisibility, type RfpDraftInput, type RfpMode, type CompareRenderer,
} from '@/lib/v2/tendering-view';
import type { Inbox, CompareEntry } from '@/lib/v2/tendering';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import RfpModelComposer from './ifc/RfpModelComposer';
import OwnerModelViewer from './ifc/OwnerModelViewer';
import './procurement.css';

/** A plan task the composer can tender over — supplied by the mounting surface. */
export interface TaskOption {
  id: string;
  name: string;
}

export function ProcurementSection({
  projectId, tasks, hasActiveOrg = true, initialMyRfps = null,
  composeTaskId = null, composeMode = 'detailed', openRfpId = null,
}: {
  projectId: string;
  /** Candidate root tasks (from the plan) the composer can put out to tender. */
  tasks: TaskOption[];
  /**
   * False when the viewer is signed in with no organisation selected — the v2
   * tendering reads require an active org, so with none this renders the neutral
   * "pick an organisation" state rather than an empty-looking inbox. The mounting
   * server component resolves this from `/me`.
   */
  hasActiveOrg?: boolean;
  /** The org's RFPs for this project, when the page already read them. */
  initialMyRfps?: V2Rfp[] | null;
  /**
   * A "Start tendering" deep-link (LINA-407): a plan package to open the composer
   * on. When set (and an org is active), the composer opens straight away with
   * this task pre-picked, in `composeMode`. Null → the normal list/empty state.
   */
  composeTaskId?: string | null;
  /** The shape the deep-link asked for — `light` for a design tender. */
  composeMode?: RfpMode;
  /**
   * A "Start tendering" deep-link raised on a task that is ALREADY out to tender
   * (LINA-420): the mounting page resolved the task to its existing RFP so the
   * owner lands on that tender's inbox — the submitted responses and Compare —
   * rather than a blank composer. Takes precedence over `composeTaskId`, which
   * the page leaves null in this case. Overridden by an explicit `?rfp=`.
   */
  openRfpId?: string | null;
}) {
  // The surface mirrors its place — which RFP is open (`?rfp=`) and, inside the
  // inbox, which bids the Compare drill-down is over (`?compare=`) — into the
  // address bar so a deep link is shareable and a reload lands where it left.
  // We read the URL ONCE at mount to seed state, then own the state and mirror
  // it back with the raw History API: a Next navigation here would re-run this
  // route's (force-dynamic) server page and the revalidation would drop in-flight
  // inbox state (the LINA-404 lesson).
  const searchParams = useSearchParams();
  const seeded = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => searchParams.get('rfp') ?? openRfpId,
  );
  const initialCompare = useRef<string | null>(searchParams.get('compare'));

  const [rfps, setRfps] = useState<V2Rfp[] | null>(initialMyRfps);
  const [loading, setLoading] = useState(hasActiveOrg && initialMyRfps === null);
  const [error, setError] = useState<string | null>(null);
  // A deep-link lands straight in the composer (LINA-407). Only when an org is
  // active — otherwise the no-org state below stands and the seed is moot.
  const [creating, setCreating] = useState(hasActiveOrg && composeTaskId !== null);

  // `?rfp=` ↔ selection. `?compare=` is written by the inbox (it owns which bids
  // are drilled into); clearing the selection clears both.
  const openRfp = useCallback((id: string | null) => {
    setSelectedId(id);
    initialCompare.current = null;
    mirrorUrl(id, null);
  }, []);
  useEffect(() => { seeded.current = true; }, []);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await loadMyRfpsAction()).filter((r) => r.project_id === projectId);
      setRfps(list);
    } catch {
      setError('Could not load your tenders.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!hasActiveOrg || initialMyRfps !== null) return;
    void refreshList();
  }, [hasActiveOrg, initialMyRfps, refreshList]);

  // ── No active org: the first-class "nothing to scope to" state ──────────────
  if (!hasActiveOrg) {
    return (
      <section className="prc" aria-label="Tendering">
        <p className="prc-quiet">
          Select an organisation to run a tender. RFPs belong to the org that issues them, so there
          is nothing to show until you are acting for one.
        </p>
      </section>
    );
  }

  if (loading && rfps === null) {
    return <p className="prc-quiet" role="status">Loading tenders…</p>;
  }

  const list = (rfps ?? []).filter((r) => r.project_id === projectId);
  const selected = list.find((r) => r.id === selectedId) ?? null;

  // Selected → the composer (draft) or the inbox (published onward).
  if (selected) {
    return (
      <RfpDetail
        key={selected.id}
        projectId={projectId}
        rfp={selected}
        initialCompare={initialCompare.current}
        onBack={() => { openRfp(null); void refreshList(); }}
        onChanged={(next) => {
          setRfps((prev) => (prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev));
        }}
      />
    );
  }

  if (creating) {
    return (
      <NewRfp
        projectId={projectId}
        tasks={tasks}
        initialMode={composeMode}
        initialTaskIds={composeTaskId ? [composeTaskId] : []}
        onCancel={() => setCreating(false)}
        onCreated={(rfp) => {
          setRfps((prev) => [rfp, ...(prev ?? [])]);
          setCreating(false);
          openRfp(rfp.id);
        }}
      />
    );
  }

  // ── The list / empty state ─────────────────────────────────────────────────
  return (
    <div className="prc">
      {error ? <p role="alert" className="prc-error">{error}</p> : null}
      <div className="prc-composer-hd">
        <h3 className="prc-h">Tenders</h3>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          New RFP
        </button>
      </div>

      {list.length === 0 ? (
        <p className="prc-quiet">
          No tenders yet. Put a piece of the plan out to bid: pick the tasks, describe the scope,
          invite contractors by email, and compare the proposals that come back — all on the shared
          record.
        </p>
      ) : (
        <div className="prc-picker">
          <ul className="prc-rfp-list">
            {list.map((r) => {
              const badge = rfpStatusBadge(r.status);
              // Per-task label (LINA-420, screen 7): which task(s) this tender roots
              // at, plus its kind — "Structures · build" / "Electrical · design".
              // Tendering is per-task now, so the task is the RFP's primary anchor.
              const taskNames = r.root_task_ids
                .map((id) => tasks.find((t) => t.id === id)?.name?.trim())
                .filter((n): n is string => !!n);
              const taskLabel = taskNames.length === 0
                ? null
                : taskNames.length <= 2
                  ? taskNames.join(', ')
                  : `${taskNames.slice(0, 2).join(', ')} +${taskNames.length - 2}`;
              const kindLabel = r.purpose === 'design' ? 'design' : 'build';
              return (
                <li key={r.id}>
                  <button type="button" className="prc-rfp-item" onClick={() => openRfp(r.id)}>
                    <span className="prc-rfp-main">
                      <span className="prc-rfp-title">{r.title}</span>
                      <span className="prc-rfp-tasks">
                        {taskLabel ? `${taskLabel} · ${kindLabel}` : kindLabel}
                      </span>
                    </span>
                    <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Create ─────────────────────────────────────────────────────────────────

function NewRfp({
  projectId, tasks, onCancel, onCreated, initialMode = 'detailed', initialTaskIds = [],
}: {
  projectId: string;
  tasks: TaskOption[];
  onCancel: () => void;
  onCreated: (rfp: V2Rfp) => void;
  /** Deep-link seed (LINA-407): a "Start tendering" link opens the composer
   *  pre-set to Light design mode with the task already picked. */
  initialMode?: RfpMode;
  initialTaskIds?: string[];
}) {
  // Light (design) vs Detailed (execution) — D-39. Light raises a design RFP:
  // the deliverable is the project itself (drawings + a spec), priced as a fee,
  // so there is NO BoQ to assemble and the public form asks for a fee +
  // portfolio + references, not a priced line list. Detailed is the as-is
  // execution tender, byte-for-byte unchanged (purpose/mode omitted → the API
  // back-fills execution/detailed).
  const [mode, setMode] = useState<RfpMode>(initialMode);
  const light = mode === 'light';

  const [title, setTitle] = useState('');
  const [scopeText, setScopeText] = useState('');
  // Only keep seeded ids that are real tasks on this plan.
  const [rootTaskIds, setRootTaskIds] = useState<string[]>(
    () => initialTaskIds.filter((id) => tasks.some((t) => t.id === id)),
  );
  const [submissionDeadline, setSubmissionDeadline] = useState('');
  const [questionsDeadline, setQuestionsDeadline] = useState('');
  const [visibility, setVisibility] = useState<RfpVisibility>('invite_only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const blocked = createBlockedReason({ title, rootTaskIds, submissionDeadline });

  const toggleTask = (id: string) => {
    setRootTaskIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const draft: RfpDraftInput = {
      title, scopeText, rootTaskIds,
      submissionDeadline: toIso(submissionDeadline),
      ...(questionsDeadline ? { questionsDeadline: toIso(questionsDeadline) } : {}),
      visibility,
      // Detailed stays implicit (defaults); Light pins purpose=design, mode=light.
      ...(light ? { purpose: 'design' as const, mode: 'light' as const } : {}),
    };
    const res = await createRfpAction(projectId, draft);
    setBusy(false);
    if (res.ok) { onCreated(res.data); return; }
    setError(res.message);
    if (res.fieldErrors) setFieldErrors(res.fieldErrors);
  };

  return (
    <section className="prc-composer" aria-label="New request for proposals">
      <div className="prc-composer-hd">
        <h3 className="prc-h">New RFP</h3>
        <span className="prc-badge quiet">Draft — not sent</span>
      </div>
      {error ? <p role="alert" className="prc-error">{error}</p> : null}

      {/* ── Light (design) / Detailed (execution) picker (LINA-407) ──────── */}
      <div className="prc-field">
        <span className="prc-label" id="prc-mode-label">What are you tendering?</span>
        <div className="prc-seg" role="radiogroup" aria-labelledby="prc-mode-label">
          <button
            type="button"
            className={`prc-seg-opt${!light ? ' is-on' : ''}`}
            role="radio"
            aria-checked={!light}
            onClick={() => setMode('detailed')}
          >
            <span className="prc-seg-title">Detailed (build)</span>
            <span className="prc-seg-sub">Price the plan line by line — a Bill of Quantities.</span>
          </button>
          <button
            type="button"
            className={`prc-seg-opt${light ? ' is-on' : ''}`}
            role="radio"
            aria-checked={light}
            onClick={() => setMode('light')}
          >
            <span className="prc-seg-title">Light (design)</span>
            <span className="prc-seg-sub">A pre-construction brief — bidders answer with a fee, portfolio and references.</span>
          </button>
        </div>
      </div>

      <div className="prc-field">
        <label className="prc-label" htmlFor="prc-title">Title</label>
        <input
          id="prc-title"
          className="prc-line"
          value={title}
          maxLength={200}
          placeholder={light ? 'e.g. Architectural design — Casa Silva' : 'e.g. Groundworks & foundations'}
          onChange={(e) => setTitle(e.target.value)}
        />
        {fieldErrors.title ? <p className="prc-reject">{fieldErrors.title}</p> : null}
      </div>

      <div className="prc-field">
        <label className="prc-label" htmlFor="prc-scope">{light ? 'Brief & deliverables' : 'Scope'}</label>
        <textarea
          id="prc-scope"
          className="prc-input"
          value={scopeText}
          maxLength={8000}
          placeholder={light
            ? 'The design intent, the deliverables you expect (drawings, a material spec), and the constraints to work within.'
            : 'What is being built and what a contractor must know to price it honestly.'}
          onChange={(e) => setScopeText(e.target.value)}
        />
      </div>

      {/* ── Which tasks go out to tender (root_task_ids) ────────────────── */}
      <div className="prc-field">
        <span className="prc-label" id="prc-tasks-label">Tasks to tender</span>
        {tasks.length === 0 ? (
          <p className="prc-quiet">
            This plan has no tasks yet — author the plan first, then a tender can be raised over it.
          </p>
        ) : (
          <ul className="prc-tasks" aria-labelledby="prc-tasks-label">
            {tasks.map((t) => (
              <li key={t.id} className="prc-task">
                <label className="prc-task">
                  <input
                    type="checkbox"
                    checked={rootTaskIds.includes(t.id)}
                    onChange={() => toggleTask(t.id)}
                  />
                  {t.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        {fieldErrors.root_task_ids ? <p className="prc-reject">{fieldErrors.root_task_ids}</p> : null}
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-subd">Submission deadline</label>
          <input
            id="prc-subd"
            className="prc-line"
            type="datetime-local"
            value={submissionDeadline}
            onChange={(e) => setSubmissionDeadline(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-qd">Questions close (optional)</label>
          <input
            id="prc-qd"
            className="prc-line"
            type="datetime-local"
            value={questionsDeadline}
            onChange={(e) => setQuestionsDeadline(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-vis">Visibility</label>
          <select
            id="prc-vis"
            className="prc-line"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as RfpVisibility)}
          >
            <option value="invite_only">Invite only</option>
            <option value="open">Open (marketplace)</option>
          </select>
        </div>
      </div>

      <div className="prc-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || blocked !== null} onClick={submit}>
          {busy ? 'Creating…' : 'Create draft'}
        </button>
        {blocked ? <span className="prc-quiet">{blocked}</span> : null}
      </div>
    </section>
  );
}

// ── Detail: composer (draft) or inbox (published onward) ─────────────────────

function RfpDetail({
  projectId, rfp: initialRfp, initialCompare, onBack, onChanged,
}: {
  projectId: string;
  rfp: V2Rfp;
  /** The `?compare=` value at mount, applied once the inbox lanes have loaded. */
  initialCompare: string | null;
  onBack: () => void;
  onChanged: (rfp: V2Rfp) => void;
}) {
  const [rfp, setRfp] = useState<V2Rfp>(initialRfp);
  const [data, setData] = useState<ComposerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setBoth = useCallback((next: V2Rfp) => { setRfp(next); onChanged(next); }, [onChanged]);

  const reload = useCallback(async () => {
    setLoading(true);
    const composer = await loadComposerAction(initialRfp.id);
    if (composer) { setData(composer); setRfp(composer.rfp); }
    setLoading(false);
  }, [initialRfp.id]);

  useEffect(() => { void reload(); }, [reload]);

  const recipients = data?.recipients ?? [];
  const specialties = packageSpecialties(rfp);

  return (
    <div className="prc">
      <div className="prc-composer-hd">
        <button type="button" className="btn" onClick={onBack}>← All tenders</button>
        <h3 className="prc-h">{rfp.title}</h3>
        <span className={`prc-badge ${rfpStatusBadge(rfp.status).tone}`}>{rfpStatusBadge(rfp.status).label}</span>
      </div>
      {error ? <p role="alert" className="prc-error">{error}</p> : null}

      {specialties.length > 0 ? (
        <ul className="prc-tags" aria-label="Trades">
          {specialties.map((s) => <li key={s} className="prc-tag">{s}</li>)}
        </ul>
      ) : null}

      {rfp.status === 'draft' ? (
        <Composer
          rfp={rfp}
          recipients={recipients}
          loading={loading}
          onError={setError}
          onRfpChanged={setBoth}
          onRecipientsChanged={(next) => setData((prev) => (prev ? { ...prev, recipients: next } : prev))}
        />
      ) : (
        <ProposalsInbox
          key={`${rfp.id}:${rfp.status}`}
          rfp={rfp}
          recipients={recipients}
          initialCompare={initialCompare}
          onError={setError}
          onRfpChanged={setBoth}
        />
      )}
    </div>
  );
}

// ── Composer (draft only) ────────────────────────────────────────────────────

function Composer({
  rfp, recipients, loading, onError, onRfpChanged, onRecipientsChanged,
}: {
  rfp: V2Rfp;
  recipients: V2Recipient[];
  loading: boolean;
  onError: (msg: string | null) => void;
  onRfpChanged: (rfp: V2Rfp) => void;
  onRecipientsChanged: (recipients: V2Recipient[]) => void;
}) {
  const [emailDraft, setEmailDraft] = useState('');
  const [rejected, setRejected] = useState<{ invalid: string[]; duplicates: string[] } | null>(null);
  const [busy, setBusy] = useState<null | 'recipients' | 'publish'>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  const emails = useMemo(() => recipients.map((r) => r.email), [recipients]);
  const blocked = publishBlockedReason(rfp, recipients.length);

  const addEmails = async () => {
    const parsed = parseRecipients(emailDraft, emails);
    setRejected(
      parsed.invalid.length || parsed.duplicates.length
        ? { invalid: parsed.invalid, duplicates: parsed.duplicates } : null,
    );
    if (parsed.valid.length === 0) return;
    setBusy('recipients');
    onError(null);
    const res = await addRecipientsAction(rfp.id, parsed.valid);
    setBusy(null);
    if (!res.ok) { onError(res.message); return; }
    // The server's rows win (id, status, and the one-time token).
    onRecipientsChanged([...recipients, ...res.data]);
    setEmailDraft(parsed.invalid.join(', '));
  };

  const publish = async () => {
    setBusy('publish');
    onError(null);
    const res = await publishRfpAction(rfp.id);
    setBusy(null);
    setConfirmingPublish(false);
    if (!res.ok) { onError(res.message); return; }
    onRfpChanged(res.data);
  };

  return (
    <section className="prc-composer" aria-label="Request for proposals">
      <p className="prc-quiet">
        Private until you publish it. No contractor can see this — the personal links do not exist
        yet. Edit the details until you are ready; publishing sends it.
      </p>

      <DraftDetails rfp={rfp} onError={onError} onRfpChanged={onRfpChanged} />

      {/* ── BIM model (IFC, view-only) — LINA-409 / doc 24 ───────────────── */}
      <RfpModelComposer rfpId={rfp.id} model={rfp.package?.models?.[0] ?? null} />

      {/* ── Recipients ──────────────────────────────────────────────────── */}
      <div className="prc-field">
        <span className="prc-label" id="prc-rcp-label">
          Invite {recipients.length > 0 ? `(${recipients.length})` : ''}
        </span>
        {loading ? (
          <p className="prc-quiet" role="status">Loading…</p>
        ) : recipients.length === 0 ? (
          <p className="prc-quiet">Nobody yet. Paste a column of addresses or add them one at a time.</p>
        ) : (
          <ul className="prc-recipients" aria-labelledby="prc-rcp-label">
            {recipients.map((r) => {
              const badge = recipientStatusBadge(r.status);
              return (
                <li key={r.id} className="prc-recipient">
                  <span className="prc-email">{r.email}</span>
                  {r.token ? <TokenLink token={r.token} /> : null}
                  <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
                </li>
              );
            })}
          </ul>
        )}

        <textarea
          className="prc-input prc-emails"
          value={emailDraft}
          aria-label="Contractor email addresses"
          placeholder="ana@obra.pt, joao@construcoes.pt — or paste a column from a spreadsheet"
          disabled={busy === 'recipients'}
          onChange={(e) => setEmailDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void addEmails(); }
          }}
        />
        <div className="prc-row">
          <button
            type="button"
            className="btn"
            disabled={busy === 'recipients' || emailDraft.trim().length === 0}
            onClick={addEmails}
          >
            Add to list
          </button>
        </div>
        {rejected ? (
          <p className="prc-reject" role="status">
            {rejected.invalid.length > 0 ? `Not an email address: ${rejected.invalid.join(', ')}. ` : ''}
            {rejected.duplicates.length > 0 ? `Already on the list: ${rejected.duplicates.join(', ')}.` : ''}
          </p>
        ) : null}
      </div>

      {/* ── Publish ─────────────────────────────────────────────────────── */}
      <div className="prc-actions">
        {confirmingPublish ? (
          <div className="prc-confirm" role="group" aria-label="Confirm publishing the RFP">
            <p className="prc-quiet">
              This mints a personal link for {recipients.length}{' '}
              {recipients.length === 1 ? 'contractor' : 'contractors'} and opens the tender for bids.
            </p>
            <button type="button" className="btn" onClick={() => setConfirmingPublish(false)}>Not yet</button>
            <button type="button" className="btn primary" disabled={busy === 'publish'} onClick={publish}>
              {busy === 'publish' ? 'Publishing…' : 'Publish it'}
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={blocked !== null}
              onClick={() => setConfirmingPublish(true)}
            >
              Publish tender
            </button>
            {blocked ? <span className="prc-quiet">{blocked}</span> : null}
          </>
        )}
      </div>
    </section>
  );
}

// ── Draft details: read view + inline editor (updateRfp) ─────────────────────
// Title, scope, deadlines and visibility are set at creation, but a draft is not
// yet a promise to anyone — so they stay editable until publish (LINA-372). The
// tendered TASKS are not editable here: the package is snapshotted from
// `root_task_ids` at creation, so changing what is tendered is a new RFP, not a
// patch. Optimistic concurrency rides on `rfp.version` (If-Match); a stale
// version surfaces the server's refusal and a re-read is one tap away.

function DraftDetails({
  rfp, onError, onRfpChanged,
}: {
  rfp: V2Rfp;
  onError: (msg: string | null) => void;
  onRfpChanged: (rfp: V2Rfp) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div className="prc-details">
        {rfp.scope_text ? <p className="prc-comment">{rfp.scope_text}</p> : (
          <p className="prc-quiet">No scope written yet.</p>
        )}
        <dl className="prc-meta">
          <div><dt>Submission deadline</dt><dd>{formatWhen(rfp.submission_deadline)}</dd></div>
          {rfp.questions_deadline ? (
            <div><dt>Questions close</dt><dd>{formatWhen(rfp.questions_deadline)}</dd></div>
          ) : null}
          <div><dt>Visibility</dt><dd>{rfp.visibility === 'open' ? 'Open (marketplace)' : 'Invite only'}</dd></div>
        </dl>
        <div className="prc-row">
          <button type="button" className="btn" onClick={() => { onError(null); setEditing(true); }}>
            Edit details
          </button>
        </div>
      </div>
    );
  }

  return (
    <DraftEditor
      rfp={rfp}
      onCancel={() => setEditing(false)}
      onSaved={(next) => { onRfpChanged(next); setEditing(false); }}
      onError={onError}
    />
  );
}

function DraftEditor({
  rfp, onCancel, onSaved, onError,
}: {
  rfp: V2Rfp;
  onCancel: () => void;
  onSaved: (rfp: V2Rfp) => void;
  onError: (msg: string | null) => void;
}) {
  const [title, setTitle] = useState(rfp.title);
  const [scopeText, setScopeText] = useState(rfp.scope_text ?? '');
  const [submissionDeadline, setSubmissionDeadline] = useState(toLocalInput(rfp.submission_deadline));
  const [questionsDeadline, setQuestionsDeadline] = useState(toLocalInput(rfp.questions_deadline));
  const [visibility, setVisibility] = useState<RfpVisibility>(rfp.visibility);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const blocked = createBlockedReason({ title, rootTaskIds: rfp.root_task_ids, submissionDeadline });

  const save = async () => {
    if (blocked) return;
    setBusy(true);
    onError(null);
    setFieldErrors({});
    const res = await updateRfpAction(rfp.id, {
      title,
      scopeText,
      submissionDeadline: toIso(submissionDeadline),
      questionsDeadline: questionsDeadline ? toIso(questionsDeadline) : null,
      visibility,
    }, rfp.version);
    setBusy(false);
    if (res.ok) { onSaved(res.data); return; }
    onError(res.message);
    if (res.fieldErrors) setFieldErrors(res.fieldErrors);
  };

  return (
    <section className="prc-composer" aria-label="Edit RFP details">
      <div className="prc-field">
        <label className="prc-label" htmlFor="prc-edit-title">Title</label>
        <input
          id="prc-edit-title"
          className="prc-line"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        {fieldErrors.title ? <p className="prc-reject">{fieldErrors.title}</p> : null}
      </div>

      <div className="prc-field">
        <label className="prc-label" htmlFor="prc-edit-scope">Scope</label>
        <textarea
          id="prc-edit-scope"
          className="prc-input"
          value={scopeText}
          maxLength={8000}
          onChange={(e) => setScopeText(e.target.value)}
        />
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-edit-subd">Submission deadline</label>
          <input
            id="prc-edit-subd"
            className="prc-line"
            type="datetime-local"
            value={submissionDeadline}
            onChange={(e) => setSubmissionDeadline(e.target.value)}
          />
          {fieldErrors.submission_deadline ? <p className="prc-reject">{fieldErrors.submission_deadline}</p> : null}
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-edit-qd">Questions close (optional)</label>
          <input
            id="prc-edit-qd"
            className="prc-line"
            type="datetime-local"
            value={questionsDeadline}
            onChange={(e) => setQuestionsDeadline(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor="prc-edit-vis">Visibility</label>
          <select
            id="prc-edit-vis"
            className="prc-line"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as RfpVisibility)}
          >
            <option value="invite_only">Invite only</option>
            <option value="open">Open (marketplace)</option>
          </select>
        </div>
      </div>

      <div className="prc-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || blocked !== null} onClick={save}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
        {blocked ? <span className="prc-quiet">{blocked}</span> : null}
      </div>
    </section>
  );
}

/** The one-time personal link, revealed to the issuer until email delivery lands. */
function TokenLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url = `/rfp/${token}`;
  return (
    <button
      type="button"
      className="prc-remove"
      title="Copy the bidder's personal link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${url}`);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — the link is still shown on hover */ }
      }}
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

// ── The inbox (published / closed / awarded) ─────────────────────────────────

function ProposalsInbox({
  rfp, recipients, initialCompare, onError, onRfpChanged,
}: {
  rfp: V2Rfp;
  recipients: V2Recipient[];
  initialCompare: string | null;
  onError: (msg: string | null) => void;
  onRfpChanged: (rfp: V2Rfp) => void;
}) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | string>(null);
  const [picked, setPicked] = useState<string | null>(rfp.awarded_proposal_id ?? null);
  const [confirmingAward, setConfirmingAward] = useState(false);
  const [offlineFor, setOfflineFor] = useState<string | null>(null);
  // The bids the Compare drill-down is over. [] = the card list; non-empty = the
  // drill-down SURFACE. Seeded once from `?compare=` after the lanes load.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareSeeded = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const next = await loadInboxAction({ id: rfp.id, root_task_ids: rfp.root_task_ids });
    setInbox(next);
    setLoading(false);
  }, [rfp.id, rfp.root_task_ids]);

  useEffect(() => { void reload(); }, [reload]);

  const lanes = useMemo(() => orderLanes(inbox?.lanes ?? []), [inbox]);

  // Open the drill-down and mirror the chosen bids into `?compare=`; [] closes it.
  const openCompare = useCallback((ids: string[]) => {
    setCompareIds(ids);
    mirrorUrl(rfp.id, ids.length > 0 ? serializeCompareIds(ids) : null);
  }, [rfp.id]);

  // Apply `?compare=` once, after the lanes exist to validate it against (a stale
  // link silently drops ids that are not bids on this RFP).
  useEffect(() => {
    if (compareSeeded.current || loading) return;
    compareSeeded.current = true;
    const ids = parseCompareIds(initialCompare, lanes.map((l) => l.proposal_id));
    if (ids.length > 0) setCompareIds(ids);
  }, [loading, initialCompare, lanes]);
  // A lane an emailed/online bid has actually landed on, vs one still only
  // invited. The invited lanes are where an issuer records an emailed bid; the
  // priced comparison and the award only ever consider the bids that are in.
  const bids = useMemo(() => lanes.filter((l) => !isAwaiting(l)), [lanes]);
  const awaiting = useMemo(() => lanes.filter(isAwaiting), [lanes]);
  const decided = rfp.status === 'awarded' || rfp.status === 'cancelled';
  const receiving = rfp.status === 'published' || rfp.status === 'closed';
  const winner = lanes.find((l) => l.proposal_id === picked) ?? null;
  const awardBlocked = awardBlockedReason(rfp, lanes, winner);
  const shortlisted = useMemo(() => shortlistedLanes(lanes), [lanes]);
  const compareBlocked = compareBlockedReason(lanes);
  const comparing = compareIds.length > 0;
  const comparedLanes = useMemo(
    () => compareIds
      .map((id) => lanes.find((l) => l.proposal_id === id))
      .filter((l): l is V2ProposalLane => l != null),
    [compareIds, lanes],
  );

  const shortlist = async (proposalId: string) => {
    setBusy(`shortlist:${proposalId}`);
    onError(null);
    const res = await shortlistAction(proposalId);
    setBusy(null);
    if (!res.ok) { onError(res.message); return; }
    void reload();
  };

  const close = async () => {
    setBusy('close');
    onError(null);
    const res = await closeRfpAction(rfp.id);
    setBusy(null);
    if (!res.ok) { onError(res.message); return; }
    onRfpChanged(res.data);
  };

  const award = async () => {
    if (!picked) return;
    setBusy('award');
    onError(null);
    const res = await awardAction(rfp.id, picked);
    setBusy(null);
    setConfirmingAward(false);
    if (!res.ok) { onError(res.message); return; }
    onRfpChanged(res.data);
    void reload();
  };

  return (
    <section className="prc-inbox" aria-label="Proposals">
      <div className="prc-composer-hd">
        <h3 className="prc-h">Proposals</h3>
        <span className="prc-count">{bids.length} in · {recipients.length} invited</span>
        {rfp.status === 'published' && !comparing ? (
          <button type="button" className="btn" disabled={busy === 'close'} onClick={close}>
            {busy === 'close' ? 'Closing…' : 'Close tender'}
          </button>
        ) : null}
      </div>

      {inbox && !inbox.seesMoney ? (
        <p className="prc-quiet">
          You can see who bid, but not the amounts — that needs the money permission on this
          organisation. Ask an owner to grant it to compare bids here.
        </p>
      ) : null}

      {/* ── BIM model (IFC, view-only) — LINA-409 / doc 24 ───────────────── */}
      {!comparing && rfp.package?.models?.[0] ? (
        <div className="prc-field">
          <OwnerModelViewer
            rfpId={rfp.id}
            documentId={rfp.package.models[0].documentId}
            fileName={rfp.package.models[0].fileName}
            sizeBytes={rfp.package.models[0].sizeBytes}
          />
        </div>
      ) : null}

      {comparing ? (
        <CompareSurface
          rfp={rfp}
          inbox={inbox}
          comparedLanes={comparedLanes}
          seesMoney={inbox?.seesMoney ?? false}
          decided={decided}
          picked={picked}
          onPick={setPicked}
          onBack={() => openCompare([])}
          award={!decided ? (
            <AwardBar
              winner={winner}
              awardBlocked={awardBlocked}
              confirming={confirmingAward}
              busy={busy === 'award'}
              onStart={() => setConfirmingAward(true)}
              onCancel={() => setConfirmingAward(false)}
              onConfirm={award}
            />
          ) : null}
        />
      ) : (
      <>
      {/* ── Bids that are in ─────────────────────────────────────────────── */}
      {loading ? (
        <p className="prc-quiet" role="status">Loading proposals…</p>
      ) : bids.length === 0 ? (
        <p className="prc-quiet">
          Nothing back yet. Each proposal appears here as it arrives; the invite list below shows who
          has opened their link.
        </p>
      ) : (
        <ul className="prc-proposals">
          {bids.map((lane) => (
            <LaneCard
              key={lane.proposal_id}
              lane={lane}
              seesMoney={inbox?.seesMoney ?? false}
              picked={picked === lane.proposal_id}
              decided={decided}
              busy={busy === `shortlist:${lane.proposal_id}`}
              onPick={() => setPicked(lane.proposal_id)}
              onShortlist={() => shortlist(lane.proposal_id)}
            />
          ))}
        </ul>
      )}

      {/* ── Shortlist → Compare: the drill-down opens only once bids are shortlisted ─ */}
      {!loading && bids.length > 0 ? (
        <div className="prc-actions">
          <button
            type="button"
            className="btn"
            disabled={compareBlocked !== null}
            onClick={() => openCompare(shortlisted.map((l) => l.proposal_id))}
          >
            Compare shortlisted{shortlisted.length > 0 ? ` (${shortlisted.length})` : ''}
          </button>
          {compareBlocked ? <span className="prc-quiet">{compareBlocked}</span> : null}
        </div>
      ) : null}

      {!decided && bids.length > 0 ? (
        <AwardBar
          winner={winner}
          awardBlocked={awardBlocked}
          confirming={confirmingAward}
          busy={busy === 'award'}
          onStart={() => setConfirmingAward(true)}
          onCancel={() => setConfirmingAward(false)}
          onConfirm={award}
        />
      ) : null}

      {/* ── Still awaiting: invited lanes, each able to record an emailed bid ─ */}
      {!loading && awaiting.length > 0 && !decided ? (
        <div className="prc-awaiting">
          <h4 className="prc-subh">
            Awaiting {awaiting.length} {awaiting.length === 1 ? 'contractor' : 'contractors'}
          </h4>
          {receiving ? (
            <p className="prc-quiet">
              Got a bid by email or over the phone? Record it here so it sits in the comparison beside
              the online ones.
            </p>
          ) : null}
          <ul className="prc-awaiting-list">
            {awaiting.map((lane) => (
              <li key={lane.proposal_id} className="prc-awaiting-row">
                <div className="prc-awaiting-hd">
                  <span className="prc-email">{lane.bidder.name ?? lane.bidder.email}</span>
                  <span className={`prc-badge ${proposalStatusBadge(lane.status).tone}`}>
                    {proposalStatusBadge(lane.status).label}
                  </span>
                  {receiving ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => { onError(null); setOfflineFor(
                        offlineFor === lane.proposal_id ? null : lane.proposal_id,
                      ); }}
                    >
                      {offlineFor === lane.proposal_id ? 'Close' : 'Record an emailed bid'}
                    </button>
                  ) : null}
                </div>
                {offlineFor === lane.proposal_id ? (
                  <RecordOfflineForm
                    proposalId={lane.proposal_id}
                    onCancel={() => setOfflineFor(null)}
                    onRecorded={() => { setOfflineFor(null); void reload(); }}
                    onError={onError}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rfp.status === 'awarded' ? (
        <p className="prc-quiet">
          Awarded. Every proposal stays here — including the ones not chosen — as the record of what
          was asked and what came back.
        </p>
      ) : null}
      </>
      )}
    </section>
  );
}

// ── Award bar (shared by the card list and the Compare drill-down) ────────────
// An irreversible action confirms in place (never a modal): the bids stay on
// screen behind the sentence. Greyed with its own reason when it cannot fire yet.

function AwardBar({
  winner, awardBlocked, confirming, busy, onStart, onCancel, onConfirm,
}: {
  winner: V2ProposalLane | null;
  awardBlocked: string | null;
  confirming: boolean;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="prc-actions">
      {confirming ? (
        <div className="prc-confirm" role="group" aria-label="Confirm the award">
          <p className="prc-quiet">
            Awarding {winner?.bidder.name ?? winner?.bidder.email} closes the tender, declines every
            other bid, and drafts their contract. It is recorded on the shared record.
          </p>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>
            {busy ? 'Awarding…' : 'Award it'}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="btn primary"
            disabled={awardBlocked !== null}
            onClick={onStart}
          >
            Award {winner ? `to ${winner.bidder.name ?? winner.bidder.email}` : 'the winner'}
          </button>
          {awardBlocked ? <span className="prc-quiet">{awardBlocked}</span> : null}
        </>
      )}
    </div>
  );
}

// ── Compare drill-down (a SURFACE, not a modal; LINA-411) ─────────────────────
// Reached only after shortlisting, over the shortlisted bids (or whatever the
// shared `?compare=` link named). Two renderers, keyed off the RFP's shape
// (D-39): a DETAILED tender tabulates per-line prices in the Matrix; a LIGHT
// tender — a design service, a fee not a BoQ — sets the bidders' references,
// notes and portfolio PDFs side by side as Docs. Back returns to the cards.

function CompareSurface({
  rfp, inbox, comparedLanes, seesMoney, decided, picked, onPick, onBack, award,
}: {
  rfp: V2Rfp;
  inbox: Inbox | null;
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
  onBack: () => void;
  award: ReactNode;
}) {
  // The renderer defaults by content (LINA-420): a light/design RFP compares as
  // Documents, a detailed/execution RFP as the price Matrix. The owner can always
  // override with the toggle — e.g. to read the attached PDFs of an execution bid
  // side by side, or scan a design bid's (rare) priced lines. Null = follow auto.
  const [override, setOverride] = useState<CompareRenderer | null>(null);
  const renderer: CompareRenderer = override ?? compareRenderer(rfp);

  return (
    <section className="prc-compare" aria-label="Compare shortlisted proposals">
      <div className="prc-composer-hd">
        <button type="button" className="btn" onClick={onBack}>← Back to proposals</button>
        <h4 className="prc-subh">
          Comparing {comparedLanes.length} {comparedLanes.length === 1 ? 'bid' : 'bids'}
          {renderer === 'docs' ? ' — references & portfolio' : ' — priced line by line'}
        </h4>
        <div className="prc-seg prc-compare-toggle" role="radiogroup" aria-label="Compare view">
          <button
            type="button" role="radio" aria-checked={renderer === 'matrix'}
            className={`prc-seg-opt${renderer === 'matrix' ? ' is-on' : ''}`}
            onClick={() => setOverride('matrix')}
          >Matrix</button>
          <button
            type="button" role="radio" aria-checked={renderer === 'docs'}
            className={`prc-seg-opt${renderer === 'docs' ? ' is-on' : ''}`}
            onClick={() => setOverride('docs')}
          >Docs</button>
        </div>
      </div>

      {comparedLanes.length === 0 ? (
        <p className="prc-quiet">None of the shortlisted bids are available to compare any more.</p>
      ) : renderer === 'docs' ? (
        <DocsCompare
          comparedLanes={comparedLanes}
          seesMoney={seesMoney}
          decided={decided}
          picked={picked}
          onPick={onPick}
        />
      ) : (
        <MatrixCompare
          comparison={inbox?.comparison ?? null}
          comparedLanes={comparedLanes}
          seesMoney={seesMoney}
          decided={decided}
          picked={picked}
          onPick={onPick}
        />
      )}

      {award}
    </section>
  );
}

// ── Matrix renderer (detailed tender): the money-gated per-line price grid ─────

function MatrixCompare({
  comparison, comparedLanes, seesMoney, decided, picked, onPick,
}: {
  comparison: V2Comparison | null;
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
}) {
  return (
    <>
      <ul className="prc-proposals">
        {comparedLanes.map((lane) => (
          <LaneCard
            key={lane.proposal_id}
            lane={lane}
            seesMoney={seesMoney}
            picked={picked === lane.proposal_id}
            decided={decided}
            busy={false}
            onPick={() => onPick(lane.proposal_id)}
            onShortlist={() => { /* already shortlisted; not offered in the drill-down */ }}
            hideShortlist
          />
        ))}
      </ul>
      {!seesMoney ? (
        <p className="prc-quiet">
          The priced matrix needs the money permission on this organisation. You can still see who
          was shortlisted and award the best fit.
        </p>
      ) : comparison ? (
        <ComparisonMatrix comparison={comparison} lanes={comparedLanes} />
      ) : (
        <p className="prc-quiet">No priced lines to compare yet.</p>
      )}
    </>
  );
}

// ── Docs renderer (light tender): references, notes and portfolio side by side ─

function DocsCompare({
  comparedLanes, seesMoney, decided, picked, onPick,
}: {
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
}) {
  const [entries, setEntries] = useState<Record<string, CompareEntry> | null>(null);
  const ids = useMemo(() => comparedLanes.map((l) => l.proposal_id), [comparedLanes]);

  useEffect(() => {
    let live = true;
    setEntries(null);
    void loadCompareAction(ids).then((list) => {
      if (!live) return;
      setEntries(Object.fromEntries(list.map((e) => [e.detail.proposal_id, e])));
    });
    return () => { live = false; };
  }, [ids]);

  return (
    <div className="prc-docs" role="group" aria-label="Bidder references side by side">
      {comparedLanes.map((lane) => (
        <DocsColumn
          key={lane.proposal_id}
          lane={lane}
          entry={entries?.[lane.proposal_id] ?? null}
          loading={entries === null}
          seesMoney={seesMoney}
          picked={picked === lane.proposal_id}
          decided={decided}
          onPick={() => onPick(lane.proposal_id)}
        />
      ))}
    </div>
  );
}

function DocsColumn({
  lane, entry, loading, seesMoney, picked, decided, onPick,
}: {
  lane: V2ProposalLane;
  entry: CompareEntry | null;
  loading: boolean;
  seesMoney: boolean;
  picked: boolean;
  decided: boolean;
  onPick: () => void;
}) {
  const badge = proposalStatusBadge(lane.status);
  const name = lane.bidder.name ?? lane.bidder.email;
  const detail = entry?.detail ?? null;
  return (
    <article className={`prc-doc-col${picked ? ' is-selected' : ''}`}>
      <header className="prc-doc-col-hd">
        <span className="prc-company">{name}</span>
        <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
      </header>

      <dl className="prc-meta">
        <div><dt>Fee</dt><dd>{seesMoney ? formatMoney(detail?.total) : '—'}</dd></div>
        {detail?.duration_wd != null ? (
          <div><dt>Lead time</dt><dd>{detail.duration_wd} working days</dd></div>
        ) : null}
        {detail?.validity_until ? (
          <div><dt>Valid until</dt><dd>{formatWhen(detail.validity_until)}</dd></div>
        ) : null}
      </dl>

      {loading ? (
        <p className="prc-quiet" role="status">Loading…</p>
      ) : (
        <>
          <div className="prc-doc-sec">
            <span className="prc-label">References</span>
            {detail?.reference_notes ? (
              <p className="prc-comment">{detail.reference_notes}</p>
            ) : (
              <p className="prc-quiet">No references given.</p>
            )}
          </div>

          {detail?.conditions ? (
            <div className="prc-doc-sec">
              <span className="prc-label">Conditions</span>
              <p className="prc-comment">{detail.conditions}</p>
            </div>
          ) : null}

          <div className="prc-doc-sec">
            <span className="prc-label">Portfolio</span>
            {entry && entry.documents.length > 0 ? (
              <ul className="prc-doc-list">
                {entry.documents.map((doc) => (
                  <li key={doc.id} className="prc-doc">
                    <a
                      className="prc-doc-name"
                      href={proposalDocumentDownloadPath(lane.proposal_id, doc.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {doc.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="prc-quiet">No files attached.</p>
            )}
          </div>
        </>
      )}

      {!decided && isLive(lane) ? (
        <div className="prc-actions">
          <button type="button" className={`btn${picked ? ' primary' : ''}`} onClick={onPick}>
            {picked ? 'Picked' : 'Pick to award'}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** A lane no bid has landed on yet — where the issuer records an emailed answer. */
function isAwaiting(lane: Pick<V2ProposalLane, 'status'>): boolean {
  return lane.status === 'invited' || lane.status === 'draft';
}

function LaneCard({
  lane, seesMoney, picked, decided, busy, onPick, onShortlist, hideShortlist = false,
}: {
  lane: V2ProposalLane;
  seesMoney: boolean;
  picked: boolean;
  decided: boolean;
  busy: boolean;
  onPick: () => void;
  onShortlist: () => void;
  /** In the Compare drill-down the bids are already shortlisted; don't re-offer it. */
  hideShortlist?: boolean;
}) {
  const badge = proposalStatusBadge(lane.status);
  const name = lane.bidder.name ?? lane.bidder.email;
  return (
    <li className={`prc-proposal${picked ? ' is-selected' : ''}`}>
      <div className="prc-proposal-hd">
        <span className="prc-company">{name}</span>
        <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
        {/* price · lead time · portfolio — the three a card is read on */}
        {seesMoney ? <span className="prc-figure">{formatMoney(lane.total)}</span> : null}
        {lane.duration_wd != null ? (
          <span className="prc-figure quiet" title={`${lane.duration_wd} working days`}>
            {leadTimeWeeks(lane.duration_wd)}
          </span>
        ) : null}
        {lane.document_count > 0 ? (
          <span className="prc-figure quiet">
            {lane.document_count} {lane.document_count === 1 ? 'file' : 'files'}
          </span>
        ) : null}
        {lane.channel === 'email' ? <span className="prc-badge quiet">By email</span> : null}
        {lane.missing_lines > 0 ? (
          <span className="prc-badge warn">{lane.missing_lines} lines unpriced</span>
        ) : null}
        {!decided && isLive(lane) ? (
          <>
            {!hideShortlist && lane.status === 'submitted' ? (
              <button type="button" className="btn" disabled={busy} onClick={onShortlist}>
                {busy ? '…' : 'Shortlist'}
              </button>
            ) : null}
            <button type="button" className={`btn${picked ? ' primary' : ''}`} onClick={onPick}>
              {picked ? 'Picked' : 'Pick to award'}
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

// ── Record an emailed bid (issuer types in an off-platform answer) ───────────
// The issuer logs a bid that arrived by email/phone against an invited lane. It
// needs at least one document (the bidder's PDFs) — uploaded to R2 through the
// reserve → PUT → complete protocol, scoped to this proposal — plus a total; the
// duration, start, validity and conditions are optional. On success the lane
// moves invited → submitted (channel = email) and joins the comparison.

function RecordOfflineForm({
  proposalId, onCancel, onRecorded, onError,
}: {
  proposalId: string;
  onCancel: () => void;
  onRecorded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [documents, setDocuments] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [totalEuros, setTotalEuros] = useState('');
  const [durationWd, setDurationWd] = useState('');
  const [start, setStart] = useState('');
  const [validityUntil, setValidityUntil] = useState('');
  const [conditions, setConditions] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const cents = eurosToCents(totalEuros);
  const blocked = documents.length === 0
    ? 'Attach at least one document from the bid.'
    : cents === null ? 'Enter the total, e.g. 180000.'
      : null;

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setLocalError(null);
    try {
      for (const file of Array.from(files)) {
        const mime = file.type || 'application/octet-stream';
        const { hex, base64 } = await digestSha256(file);
        const reserve = await reserveProposalDocumentAction(proposalId, {
          name: file.name, mime, sizeBytes: file.size, sha256: hex,
        });
        if (!reserve.ok) { setLocalError(reserve.message); break; }
        await putToTicket(reserve.data.uploadUrl, file, mime, base64);
        const done = await completeProposalDocumentAction(reserve.data.versionRef);
        if (!done.ok) { setLocalError(done.message); break; }
        const { documentId } = reserve.data;
        setDocuments((prev) => [...prev, { id: documentId, name: file.name }]);
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'That file did not upload. Try again.');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (blocked || cents === null) { setLocalError(blocked); return; }
    setBusy(true);
    onError(null);
    setLocalError(null);
    const dur = durationWd.trim() ? Math.round(Number(durationWd)) : undefined;
    const res = await recordOfflineAction(proposalId, {
      documentIds: documents.map((d) => d.id),
      totalCents: cents,
      ...(dur !== undefined && Number.isFinite(dur) ? { durationWd: dur } : {}),
      ...(start ? { start } : {}),
      ...(validityUntil ? { validityUntil } : {}),
      ...(conditions.trim() ? { conditions: conditions.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) { onError(res.message); return; }
    onRecorded();
  };

  return (
    <div className="prc-offline" role="group" aria-label="Record an emailed bid">
      {localError ? <p role="alert" className="prc-reject">{localError}</p> : null}

      {/* ── Documents (at least one) ─────────────────────────────────────── */}
      <div className="prc-field">
        <span className="prc-label">The bid documents</span>
        {documents.length > 0 ? (
          <ul className="prc-doc-list">
            {documents.map((d) => (
              <li key={d.id} className="prc-doc">
                <span className="prc-doc-name">{d.name}</span>
                <button
                  type="button"
                  className="prc-remove"
                  disabled={busy}
                  onClick={() => setDocuments((prev) => prev.filter((x) => x.id !== d.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="prc-quiet">The PDF or images the contractor sent. At least one.</p>
        )}
        <label className={`btn tws-upload${uploading ? ' is-busy' : ''}`}>
          {uploading ? 'Uploading…' : 'Attach a file'}
          <input
            type="file"
            multiple
            className="prc-file-input"
            disabled={uploading || busy}
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-total-${proposalId}`}>Total (EUR)</label>
          <input
            id={`prc-off-total-${proposalId}`}
            className="prc-line"
            inputMode="decimal"
            placeholder="180000"
            value={totalEuros}
            onChange={(e) => setTotalEuros(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-dur-${proposalId}`}>Duration (working days)</label>
          <input
            id={`prc-off-dur-${proposalId}`}
            className="prc-line"
            inputMode="numeric"
            placeholder="optional"
            value={durationWd}
            onChange={(e) => setDurationWd(e.target.value)}
          />
        </div>
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-start-${proposalId}`}>Can start</label>
          <input
            id={`prc-off-start-${proposalId}`}
            className="prc-line"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-val-${proposalId}`}>Valid until</label>
          <input
            id={`prc-off-val-${proposalId}`}
            className="prc-line"
            type="date"
            value={validityUntil}
            onChange={(e) => setValidityUntil(e.target.value)}
          />
        </div>
      </div>

      <div className="prc-field">
        <label className="prc-label" htmlFor={`prc-off-cond-${proposalId}`}>Conditions (optional)</label>
        <textarea
          id={`prc-off-cond-${proposalId}`}
          className="prc-input"
          value={conditions}
          maxLength={2000}
          placeholder="Anything the contractor noted alongside the price."
          onChange={(e) => setConditions(e.target.value)}
        />
      </div>

      <div className="prc-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || uploading || blocked !== null}
          onClick={submit}
        >
          {busy ? 'Recording…' : 'Record the bid'}
        </button>
        {blocked && !uploading ? <span className="prc-quiet">{blocked}</span> : null}
      </div>
    </div>
  );
}

// ── Comparison matrix (money-gated) ──────────────────────────────────────────

function ComparisonMatrix({
  comparison, lanes,
}: {
  comparison: V2Comparison;
  lanes: V2ProposalLane[];
}) {
  const byId = new Map(lanes.map((l) => [l.proposal_id, l]));
  // Columns are the bids the server actually compares (submitted/shortlisted/
  // awarded), in the ordered-lane order so the matrix reads like the list above.
  // A declined or withdrawn lane still shows as a card but is not a column here —
  // there is no live price to compare.
  const compared = new Set(comparison.proposals.map((p) => p.proposal_id));
  const cols = lanes.map((l) => l.proposal_id).filter((id) => byId.has(id) && compared.has(id));

  if (comparison.items.length === 0 || cols.length === 0) return null;

  return (
    <div className="prc-matrix-wrap">
      <table className="prc-matrix">
        <thead>
          <tr>
            <th>Line</th>
            {cols.map((id) => (
              <th key={id}>{byId.get(id)?.bidder.name ?? byId.get(id)?.bidder.email ?? id}</th>
            ))}
            <th className="prc-median">Median</th>
          </tr>
        </thead>
        <tbody>
          {comparison.items.map((item) => (
            <tr key={item.rfp_item_id}>
              <td>{item.description} <span className="prc-median">({item.quantity} {item.unit})</span></td>
              {cols.map((id) => {
                const price = item.prices[id];
                const missing = item.missing_in.includes(id);
                return (
                  <td key={id} className={missing ? 'prc-missing' : undefined}>
                    {missing ? '— not priced' : formatMoney(price)}
                  </td>
                );
              })}
              <td className="prc-median">{formatMoney(item.median)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ProgrammeBars comparison={comparison} byId={byId} cols={cols} />
    </div>
  );
}

/**
 * The PROGRAMME section of the compare matrix (LINA-420, screen 8): each bidder's
 * weeks-on-site as a proportional bar, read off `comparison.durations` (already on
 * the wire; weeks via the same 5-wd week the cards speak). The shortest is tagged
 * "fastest" — the one call this section exists to make. Nothing renders when no
 * bidder gave a duration; it never invents a programme it wasn't told.
 */
function ProgrammeBars({
  comparison, byId, cols,
}: {
  comparison: V2Comparison;
  byId: Map<string, V2ProposalLane>;
  cols: string[];
}) {
  // Per proposal: total working days summed over every packaged task it priced.
  const totals = new Map<string, number>();
  for (const id of cols) {
    let wd = 0;
    let any = false;
    for (const d of comparison.durations) {
      const v = d.by_proposal[id];
      if (v != null && Number.isFinite(v)) { wd += v; any = true; }
    }
    if (any) totals.set(id, wd);
  }
  if (totals.size === 0) return null;

  const values = [...totals.values()];
  const max = Math.max(...values);
  const min = Math.min(...values);

  return (
    <div className="prc-programme">
      <div className="prc-programme-hd">
        Programme <span className="prc-median">weeks on site</span>
      </div>
      <ul className="prc-programme-rows">
        {cols.filter((id) => totals.has(id)).map((id) => {
          const wd = totals.get(id)!;
          const pct = max > 0 ? Math.max(6, Math.round((wd / max) * 100)) : 0;
          const fastest = wd === min && values.length > 1;
          const name = byId.get(id)?.bidder.name ?? byId.get(id)?.bidder.email ?? id;
          return (
            <li key={id} className={`prc-programme-row${fastest ? ' is-fastest' : ''}`}>
              <span className="prc-programme-name">{name}</span>
              <span className="prc-programme-track" aria-hidden>
                <span className="prc-programme-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="prc-programme-wks">
                {leadTimeWeeks(wd)}
                {fastest ? <span className="prc-badge good">fastest</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Mirror the surface's place into the address bar — `?rfp=` (which tender is
 * open) and `?compare=` (which bids the drill-down is over) — using the raw
 * History API so the URL is shareable and reload-safe without a Next navigation
 * (which would re-run this force-dynamic route and revalidate away inbox state).
 */
function mirrorUrl(rfpId: string | null, compare: string | null): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (rfpId) params.set('rfp', rfpId); else params.delete('rfp');
  if (compare) params.set('compare', compare); else params.delete('compare');
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
}

/** A `datetime-local` value ("2026-01-05T09:00") → an ISO instant for the wire. */
function toIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? local : d.toISOString();
}

/** An ISO instant → a `datetime-local` value in the viewer's timezone, or ''. */
function toLocalInput(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Shift by the offset so the local wall-clock fields match what the input wants.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** An ISO instant as a short human date-time, or an em dash when absent. */
function formatWhen(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
