'use client';

// Follow a tender that is out for bids (PRD-02 B3, T-10..T-13): the stepper
// with dates, bids due, what it covers, the locked plan dates, the award-by
// alert, the bidders (Copy link for those who have not opened theirs), "invite
// more", recording an emailed bid INLINE, and the proposals that are in.
// Shared by the panel and the workspace's Overview. PRD-04 X-5: bidders carry
// their source tag, "Asking to bid" lists the companies that asked from the
// open request (Approve / Decline), and "＋ Find more in the directory" opens
// the search prefilled from the task, adding to this tender and coming back.

import { useMemo, useState } from 'react';
import Link from 'next/link';

import { addRecipientsAction, closeRfpAction, reissueLinkAction } from '../procurement-actions';
import type { TenderFollow as FollowData } from '@/lib/v2/tender-flow';
import {
  coversLabel, daysUntil, duePhrase, fmtDay, fmtDeadline, fmtShort, isLanded, offersCopyLink,
  type V2TenderWindow,
} from '@/lib/v2/tender-flow-view';
import {
  formatMoney, parseRecipients, recipientStatusBadge, type V2ProposalLane, type V2Rfp,
} from '@/lib/v2/tendering-view';
import { directoryHref } from '@/lib/v2/rfp-directory-view';
import { AskingToBid } from './AskingToBid';
import { CancelTender } from './CancelTender';
import { BidderRow } from './DirectoryBits';
import { RecordOfflineForm } from './RecordOfflineForm';
import { CriticalAlert, TenderStepper } from './TenderBits';

export function TenderFollow({
  rfp, data, window, taskName, todayIso, canIssue, onRfpChanged, onReload, specialtyCode = null,
}: {
  rfp: V2Rfp;
  data: FollowData | null;
  window: V2TenderWindow | null;
  taskName: string;
  todayIso: string;
  canIssue: boolean;
  onRfpChanged: (rfp: V2Rfp) => void;
  onReload: () => Promise<void>;
  /** PRD-04: the task's directory specialty, for "Find more in the directory". */
  specialtyCode?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [offlineFor, setOfflineFor] = useState<string | null>(null);

  const lanes = useMemo(() => data?.lanes ?? [], [data]);
  const recipients = data?.recipients ?? [];
  const landed = lanes.filter(isLanded);
  const awaiting = lanes.filter((l) => l.status === 'invited' || l.status === 'draft');
  const laneByEmail = useMemo(() => {
    const m = new Map<string, V2ProposalLane>();
    for (const l of lanes) m.set(l.bidder.email.toLowerCase(), l);
    return m;
  }, [lanes]);
  const receiving = rfp.status === 'published';

  const copyLink = async (recipientId: string) => {
    setBusy(`copy:${recipientId}`); setError(null);
    const res = await reissueLinkAction(rfp.id, recipientId);
    setBusy(null);
    if (!res.ok || !res.data.token) { setError(res.ok ? 'No link came back. Try again.' : res.message); return; }
    try {
      await navigator.clipboard.writeText(`${browserOrigin()}/rfp/${res.data.token}`);
      setCopied(recipientId);
    } catch {
      setError('The link could not be copied. It was re-sent to the bidder by email.');
    }
    void onReload();
  };

  const invite = async () => {
    const parsed = parseRecipients(emails, recipients.map((r) => r.email));
    if (parsed.valid.length === 0) { setError(parsed.invalid.length ? `Not an email address: ${parsed.invalid.join(', ')}` : 'Already on the list.'); return; }
    setBusy('invite'); setError(null);
    const res = await addRecipientsAction(rfp.id, parsed.valid);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setEmails(''); setInviting(false);
    void onReload();
  };

  const close = async () => {
    setBusy('close'); setError(null);
    const res = await closeRfpAction(rfp.id);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    onRfpChanged(res.data);
  };

  const dueN = daysUntil(rfp.submission_deadline, todayIso);
  const ww = window?.work_window ?? null;

  return (
    <div className="tnd" aria-label="Tender out for bids">
      <TenderStepper rfp={rfp} proposalsIn={landed.length} />
      <dl className="tnd-kv">
        <dt>Bids due</dt>
        <dd><b>{fmtDeadline(rfp.submission_deadline)}</b>{dueN != null ? <span className="tnd-note"> · {duePhrase(dueN)}</span> : null}</dd>
        <dt>Covers</dt>
        <dd><span className="tnd-badge live">{coversLabel(taskName, window?.covered_task_ids.length ?? rfp.root_task_ids.length, rfp.root_task_ids.length)}</span></dd>
        <dt>Plan dates</dt>
        <dd className="tnd-note is-strong">
          {ww ? `${fmtShort(ww.start)} → ${fmtDay(ww.finish)}` : 'No dates yet'}
          {receiving ? ' · locked until a bid is chosen' : ''}
        </dd>
      </dl>
      <CriticalAlert window={window} taskName={taskName} phase="follow" />
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}

      {rfp.listed || rfp.visibility === 'open' ? (
        <AskingToBid rfpId={rfp.id} canDecide={canIssue && receiving} onDecided={() => void onReload()} />
      ) : null}

      <section className="tnd" style={{ gap: 8 }} aria-label="Bidders">
        <div className="tnd-row is-split">
          <b className="tnd-h">Bidders ({recipients.length})</b>
          {canIssue && receiving ? (
            <span className="tnd-row">
              {rfp.root_task_ids[0] ? (
                <Link className="btn sm" href={directoryHref({
                  projectId: rfp.project_id, taskId: rfp.root_task_ids[0], rfpId: rfp.id,
                  specialtyCode: specialtyCode ?? rfp.specialty_codes?.[0] ?? null,
                })}>＋ Find more in the directory</Link>
              ) : null}
              <button type="button" className="btn sm" onClick={() => setInviting((v) => !v)}>＋ Invite by email</button>
            </span>
          ) : null}
        </div>
        {inviting ? (
          <div className="tnd-sub">
            <textarea className="tnd-input" value={emails} aria-label="More contractor emails"
              placeholder="Each gets their own email with a personal link, sent now."
              onChange={(e) => setEmails(e.target.value)} />
            <div className="tnd-row">
              <button type="button" className="btn primary sm" disabled={busy === 'invite' || !emails.trim()} onClick={() => void invite()}>
                {busy === 'invite' ? 'Sending…' : 'Send invites'}
              </button>
            </div>
          </div>
        ) : null}
        {recipients.length === 0 ? (
          <p className="tnd-note">{data ? 'No bidders yet.' : 'Loading bidders…'}</p>
        ) : (
          <div className="tnd-card">
            {recipients.map((r) => {
              const badge = recipientStatusBadge(r.status);
              const lane = laneByEmail.get(r.email.toLowerCase());
              return (
                <BidderRow key={r.id} recipient={r}>
                  <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
                  {lane?.total ? <b className="tnd-num">{formatMoney(lane.total)}</b> : null}
                  {canIssue && receiving && offersCopyLink(r) && (!lane || lane.status === 'invited' || lane.status === 'draft') ? (
                    <button type="button" className="btn sm" disabled={busy === `copy:${r.id}`}
                      title="Makes a fresh personal link (the old one stops working), re-sends it, and copies it"
                      onClick={() => void copyLink(r.id)}>
                      {copied === r.id ? 'Copied' : 'Copy link'}
                    </button>
                  ) : null}
                </BidderRow>
              );
            })}
          </div>
        )}
        {canIssue && rfp.status !== 'awarded' && rfp.status !== 'cancelled' && awaiting.length > 0 ? (
          offlineFor ? (
            <div className="tnd-sub">
              <div className="tnd-row is-split">
                <b>Emailed bid from {awaiting.find((l) => l.proposal_id === offlineFor)?.bidder.email}</b>
                <button type="button" className="tnd-link" onClick={() => setOfflineFor(null)}>Close</button>
              </div>
              <RecordOfflineForm proposalId={offlineFor} onError={setError}
                onCancel={() => setOfflineFor(null)}
                onRecorded={() => { setOfflineFor(null); void onReload(); }} />
            </div>
          ) : (
            <div className="tnd-row">
              <span className="tnd-note">Got a bid by email or over the phone?</span>
              <select className="tnd-input" aria-label="Record an emailed bid from" value=""
                onChange={(e) => { if (e.target.value) setOfflineFor(e.target.value); }}>
                <option value="">Record an emailed bid from…</option>
                {awaiting.map((l) => <option key={l.proposal_id} value={l.proposal_id}>{l.bidder.name ?? l.bidder.email}</option>)}
              </select>
            </div>
          )
        ) : null}
      </section>

      <section className="tnd" style={{ gap: 8 }} aria-label="Proposals in">
        <b className="tnd-h">Proposals in</b>
        {landed.length === 0 ? <p className="tnd-note">Nothing back yet.</p> : landed.map((l) => (
          <div key={l.proposal_id} className="tnd-bid">
            <span className="co">{l.bidder.name ?? l.bidder.email}{l.channel === 'email' ? ' · by email' : ''}</span>
            <span className="amt">{formatMoney(l.total)}</span>
            <span className="meta">
              {[l.duration_wd != null ? `${l.duration_wd} working days` : null,
                l.validity_until ? `valid until ${fmtDay(l.validity_until)}` : null,
                l.document_count ? `${l.document_count} ${l.document_count === 1 ? 'file' : 'files'}` : null]
                .filter(Boolean).join(' · ') || '—'}
            </span>
            <span className="meta" style={{ textAlign: 'right' }}>{l.start ? `can start ${fmtShort(l.start)}` : ''}</span>
          </div>
        ))}
        {receiving ? <p className="tnd-note">Compare and award open when bidding closes, or close it early once you have enough.</p> : null}
      </section>

      {canIssue && receiving ? (
        <div className="tnd-row is-split">
          <CancelTender rfp={rfp} onCancelled={onRfpChanged} />
          <button type="button" className="btn primary sm" disabled={busy === 'close'} onClick={() => void close()}>
            {busy === 'close' ? 'Closing…' : 'Close bidding now'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function browserOrigin(): string {
  return typeof globalThis.location !== 'undefined' ? globalThis.location.origin : '';
}
