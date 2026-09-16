'use client';

// Execution-phase sign-off controls (LINA-282, ADR-0023 §6).
//
// One component carries every side of the moment, because they are the same
// moment seen from two chairs and splitting them is how the two copies drift:
//
//   driver, plan open      → [Request sign-off]  (disabled + why, if empty)
//   driver, request open   → "Sent for sign-off. Awaiting <approver>."
//   approver, request open → [Approve] [Request changes →  comment modal]
//   driver, rejected       → the approver's comment, verbatim, and ask again
//   anyone, signed off     → who signed, when, and the change-order door
//
// Which of those renders is decided by `signOffControls` in @/lib/phase-signoff
// and unit-tested there; this file is fetch plumbing and markup.
//
// ── NOTHING IS REPORTED THAT DID NOT PERSIST ─────────────────────────────────
// Every non-2xx is a failure, including 404 (the lesson LINA-57 left on
// CoDecisionButtons). A sign-off is the plan turning into a commitment; the UI
// must never say it happened because a route was missing.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  signOffControls, signOffStamp, BADGE_LABEL,
  type ExecutionPhase, type SignOffRequest, type SignOffViewerContext,
} from '@/lib/phase-signoff';
import { Check, StatusIcon } from './icons';

type Busy = null | 'requesting' | 'approving' | 'rejecting';

export interface SignOffPanelProps {
  /**
   * Required: the sign-off routes are project-nested (LINA-278 as built), so a
   * phase id alone cannot address them. See `signOffPath` below.
   */
  projectId: string;
  phase: ExecutionPhase | null;
  viewer: SignOffViewerContext;
  /** Tasks + sub-tasks currently in the plan — the "anything to sign off" test. */
  taskCount: number;
  /** Resolves a party id to a name; the panel never invents one. */
  nameOf?: (partyId: string) => string | undefined;
  /** Where "Raise a change order" goes once the plan is locked. */
  changeOrderHref?: string;
}

/**
 * The one place the sign-off URL shape lives (LINA-290).
 *
 * LINA-282 built this panel ahead of the API against flat guesses
 * (`/api/v1/phases/:phaseId/sign-off`, `/api/v1/sign-off/:requestId/approve`).
 * LINA-278 shipped every route nested under the project instead, so all three
 * guesses returned 404 — which the guard above correctly surfaced as "nothing
 * was recorded", but only after the user had asked for a commitment. Verified
 * against the as-built route files under
 * `app/src/app/api/v1/projects/[id]/phases/[phaseId]/sign-off/`.
 */
function signOffPath(projectId: string, phaseId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/phases/${phaseId}/sign-off${suffix}`;
}

export function SignOffPanel({
  projectId, phase, viewer, taskCount, nameOf, changeOrderHref,
}: SignOffPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');

  const c = signOffControls(phase, viewer, taskCount);
  const who = (r: SignOffRequest) => r.requestedByName ?? nameOf?.(r.requestedBy) ?? 'the other party';

  async function post(url: string, body: unknown, mode: Exclude<Busy, null>) {
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error?.message ?? `Nothing was recorded (${res.status}). The plan is unchanged.`);
        setBusy(null);
        return false;
      }
      setBusy(null);
      setConfirming(false);
      setRejecting(false);
      setComment('');
      router.refresh();
      return true;
    } catch {
      setError('The request could not be sent, so nothing was recorded. Check your connection and try again.');
      setBusy(null);
      return false;
    }
  }

  if (!phase) return null;

  return (
    <section className="so" aria-label="Plan sign-off">
      {/* ── The driver's control ─────────────────────────────────────────── */}
      {c.showRequestButton ? (
        <div className="so-ask">
          <button
            type="button"
            className="btn approve so-askbtn"
            disabled={c.requestDisabled || busy !== null}
            aria-describedby={c.requestBlockedCopy ? 'so-blocked' : undefined}
            title={c.requestBlockedCopy ?? undefined}
            onClick={() => setConfirming(true)}
          >
            Request sign-off
          </button>
          {/* The reason is TEXT as well as a tooltip: a `title` is unreachable
              by touch and by most screen readers, and "why is this greyed out"
              is exactly the question the disabled state creates. */}
          {c.requestBlockedCopy ? (
            <p className="cap so-blocked" id="so-blocked">{c.requestBlockedCopy}</p>
          ) : null}
        </div>
      ) : null}

      {/* ── The requester, waiting ───────────────────────────────────────── */}
      {c.showAwaitingBanner && c.pendingRequest ? (
        <div className="so-banner is-await" role="status">
          <StatusIcon name="alert-triangle" />
          <div>
            <p className="so-banner-t">Plan sent for sign-off. Awaiting approval.</p>
            <p className="cap">
              Requested {signOffStamp({ ...c.pendingRequest, resolvedAt: c.pendingRequest.requestedAt }) ?? 'just now'}.
              The plan is read-only until it is approved or changes are requested.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── The approver's decision ──────────────────────────────────────── */}
      {c.showDecisionControls && c.pendingRequest ? (
        <div className="so-banner is-decide">
          <StatusIcon name="alert-triangle" />
          <div className="so-decide-body">
            <p className="so-banner-t">{who(c.pendingRequest)} is asking you to sign off on this plan.</p>
            <p className="cap">
              Once signed off, every change to the plan has to go through a change order.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn approve"
                disabled={busy !== null}
                onClick={() => void post(
                  signOffPath(projectId, phase!.id, `/${c.pendingRequest!.id}/approve`), {}, 'approving',
                )}
              >
                <Check className="ok-stroke" /> Approve and lock the plan
              </button>
              <button type="button" className="btn reject" disabled={busy !== null} onClick={() => setRejecting(true)}>
                Request changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── The rejection the driver still has to answer ──────────────────── */}
      {c.rejection ? (
        <div className="so-banner is-reject" role="status">
          <StatusIcon name="alert-octagon" />
          <div>
            <p className="so-banner-t">Changes were requested — the plan is editable again.</p>
            {c.rejection.resolutionComment ? (
              // Verbatim, and attributed. Paraphrasing the reason a sign-off was
              // refused would be the record editing the argument it exists to settle.
              <blockquote className="so-quote">{c.rejection.resolutionComment}</blockquote>
            ) : (
              <p className="cap">No comment was left.</p>
            )}
            <p className="cap">
              {c.rejection.resolvedByName ?? 'The approver'}
              {signOffStamp(c.rejection) ? ` · ${signOffStamp(c.rejection)}` : ''}
            </p>
          </div>
        </div>
      ) : null}

      {/* ── Signed off: who, when, and the only remaining door ────────────── */}
      {c.approval ? (
        <div className="so-banner is-signed" role="status">
          <Check className="ok-stroke" />
          <div>
            <p className="so-banner-t">
              This plan is signed off{c.approval.resolvedByName ? ` by ${c.approval.resolvedByName}` : ''}
              {signOffStamp(c.approval) ? ` on ${signOffStamp(c.approval)}` : ''}.
            </p>
            <p className="cap">To make changes, raise a change order.</p>
            {changeOrderHref ? (
              <a className="btn" href={changeOrderHref}>Raise a change order →</a>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <div className="integrity bad" role="alert">{error}</div> : null}

      {/* ── History — every request, including the ones that were refused ─── */}
      {(phase.signOffRequests ?? []).length > 0 ? (
        <details className="so-history">
          <summary>Sign-off history ({phase.signOffRequests.length})</summary>
          <ol className="so-log">
            {[...phase.signOffRequests]
              .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
              .map((r) => (
                <li key={r.id} className={`so-log-row is-${r.status}`}>
                  <span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}`}>
                    {r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Changes requested' : 'Pending'}
                  </span>
                  <span className="so-log-txt">
                    Requested by {who(r)}
                    {r.resolvedAt ? ` · resolved ${signOffStamp(r)}` : ''}
                    {r.resolvedByName ? ` by ${r.resolvedByName}` : ''}
                  </span>
                  {r.resolutionComment ? <blockquote className="so-quote">{r.resolutionComment}</blockquote> : null}
                </li>
              ))}
          </ol>
        </details>
      ) : null}

      {/* ── Confirm modal: the ADR's exact words about what is being given up ── */}
      {confirming ? (
        <SignOffModal
          title="Request sign-off"
          onClose={() => setConfirming(false)}
          busy={busy !== null}
          confirmLabel="Request sign-off"
          onConfirm={() => void post(signOffPath(projectId, phase.id), {}, 'requesting')}
        >
          <p>You are asking the other party to sign off on this plan as it stands.</p>
          <p className="cap">
            The plan becomes read-only while they decide. Once they sign off, all changes must
            go through a change order.
          </p>
        </SignOffModal>
      ) : null}

      {/* ── Reject modal: a comment is the point, so it is required ───────── */}
      {rejecting && c.pendingRequest ? (
        <SignOffModal
          title="Request changes"
          onClose={() => setRejecting(false)}
          busy={busy !== null}
          confirmLabel="Send back for changes"
          confirmDisabled={comment.trim().length === 0}
          onConfirm={() =>
            void post(
              signOffPath(projectId, phase!.id, `/${c.pendingRequest!.id}/reject`),
              { comment: comment.trim() },
              'rejecting',
            )
          }
        >
          <label className="so-label" htmlFor="so-comment">What needs to change?</label>
          <textarea
            id="so-comment"
            className="so-textarea"
            rows={5}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="The reason goes on the record and is shown to whoever asked."
          />
          <p className="cap">
            Sending this back unlocks the plan so it can be edited again.
          </p>
        </SignOffModal>
      ) : null}
    </section>
  );
}

/** The shared confirm shell — scrim, labelled dialog, Cancel + one action. */
function SignOffModal({
  title, children, onClose, onConfirm, confirmLabel, confirmDisabled, busy,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  busy: boolean;
}) {
  return (
    <div className="so-scrim" role="presentation" onClick={onClose}>
      <div
        className="so-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h2 className="so-modal-t">{title}</h2>
        <div className="so-modal-body">{children}</div>
        <div className="btn-row so-modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn approve" onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The accordion header's badge (ADR-0023 §6). Exported here so the shell
 * (LINA-281) renders the same word the panel does.
 */
export function PhaseBadge({ phase }: { phase: ExecutionPhase | null }) {
  const c = signOffControls(phase, { partyId: null, canDecide: false, canRequest: false }, 0);
  const tone = c.badge === 'signed_off' ? 'ok' : c.badge === 'awaiting_sign_off' ? 'warn' : 'neutral';
  const stamp = signOffStamp(c.approval);
  return (
    <span className="so-hdr">
      <span className={`badge ${tone}`}>{BADGE_LABEL[c.badge]}</span>
      {/* The collapsed signed-off header carries the stamp, so the section does
          not have to be opened to answer "when, and by whom". */}
      {c.approval && stamp ? (
        <span className="cap so-hdr-stamp">
          {stamp}{c.approval.resolvedByName ? ` · ${c.approval.resolvedByName}` : ''}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The clay/amber "Change pending" marker (ADR-0023 §6). Always rendered
 * ALONGSIDE the tint, never instead of it: the locked grid is `aria-disabled`
 * and colour alone would be the only signal.
 */
export function PendingChangeChip({ label = 'Change pending' }: { label?: string }) {
  return (
    <span className="badge pending-change" title={label}>
      <StatusIcon name="alert-triangle" />
      {label}
    </span>
  );
}
