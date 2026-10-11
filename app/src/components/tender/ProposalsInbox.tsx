'use client';

// The proposals inbox of one tender (published onward): the bids that are in,
// shortlist, the Compare drill-down over the shortlisted bids (mirrored into
// `?compare=`), close, and award (moved out of ProcurementSection; behaviour
// unchanged). Recording an emailed bid lives in the workspace's "Emailed bids"
// section and in the panel, not here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  awardAction, closeRfpAction, loadComposerAction, loadInboxAction, shortlistAction,
} from '../procurement-actions';
import {
  awardBlockedReason, compareBlockedReason, orderLanes, parseCompareIds, serializeCompareIds,
  shortlistedLanes, type V2ProposalLane, type V2Recipient, type V2Rfp,
} from '@/lib/v2/tendering-view';
import type { Inbox } from '@/lib/v2/tendering';
import OwnerModelViewer from '../ifc/OwnerModelViewer';
import { CompareSurface, LaneCard } from './CompareViews';
import { mirrorCompare } from './url';
import '../procurement.css';

// ── The inbox (published / closed / awarded) ─────────────────────────────────

export function ProposalsInbox({
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
    mirrorCompare(ids.length > 0 ? serializeCompareIds(ids) : null);
  }, []);

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
    // awardRfp answers with the drafted CONTRACT, not the RFP: re-read the RFP.
    const fresh = await loadComposerAction(rfp.id);
    if (fresh) onRfpChanged(fresh.rfp);
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
            documentId={rfp.package.models[0].document_id}
            fileName={rfp.package.models[0].file_name}
            sizeBytes={rfp.package.models[0].size_bytes}
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

      {!loading && awaiting.length > 0 && !decided ? (
        <p className="prc-quiet">
          Awaiting {awaiting.length} {awaiting.length === 1 ? 'contractor' : 'contractors'}. Got a bid by
          email or over the phone? Record it under “Emailed bids”.
        </p>
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

/** A lane no bid has landed on yet — where the issuer records an emailed answer. */
export function isAwaiting(lane: Pick<V2ProposalLane, 'status'>): boolean {
  return lane.status === 'invited' || lane.status === 'draft';
}
