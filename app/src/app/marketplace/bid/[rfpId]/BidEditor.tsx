'use client';

// /marketplace/bid/[rfpId] — the self-serve bid editor (LINA-406, Slice 3). The
// discovery surface (Slice 2) let a company find an open RFP and claim a lane;
// this is where it finally PRICES and SENDS that bid. It is the authenticated
// twin of the public token form (`/rfp/[token]`), and deliberately shares the
// SAME pure `validateBid` so the two bid surfaces give identical field feedback
// and the server re-runs the same authority.
//
// It imports only the pure view helpers and types — never the server-only I/O —
// so nothing here drags `server-only` into the client bundle; the one write goes
// through the `bidAction` server action.
//
// There is no portfolio-upload tray here (unlike the token form): the only
// upload route today is token-scoped (LINA-370), so an authenticated bidder sends
// a figure + conditions for now; an authed upload is a clean follow-up.
import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  BID_CURRENCY,
  EMPTY_DRAFT,
  formatDateOnly,
  formatEuro,
  formatWorkingDays,
  validateBid,
  type BidDraft,
  type BidErrors,
  type DurationUnit,
} from '@/lib/v2/rfp-link-view';
import type { AppliedLane } from '@/lib/v2/marketplace';
import type { V2Rfp } from '@/lib/v2/tendering-view';

import { bidAction } from './actions';
import '../../marketplace.css';

/** The lane's stored figure → the editable draft, so a revise opens pre-filled. */
function draftFromLane(lane: AppliedLane): BidDraft {
  if (!lane.summary) return EMPTY_DRAFT;
  const cents = lane.summary.total.amount_cents;
  const euros = cents / 100;
  return {
    total: Number.isInteger(euros) ? String(euros) : euros.toFixed(2),
    durationValue: lane.summary.duration_wd ? String(lane.summary.duration_wd) : '',
    durationUnit: 'wd',
    conditions: lane.conditions ?? '',
    validityUntil: lane.validity_until ?? '',
  };
}

export function BidEditor({ rfp, lane }: { rfp: V2Rfp; lane: AppliedLane }) {
  const router = useRouter();
  const [draft, setDraft] = useState<BidDraft>(() => draftFromLane(lane));
  const [errors, setErrors] = useState<BidErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [sent, setSent] = useState(lane.status === 'submitted');
  const [pending, startTransition] = useTransition();
  const bannerRef = useRef<HTMLParagraphElement | null>(null);

  const set = useCallback(<K extends keyof BidDraft>(key: K, value: BidDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (pending) return;
      const checked = validateBid(draft, new Date());
      if (!checked.ok) {
        setErrors(checked.errors);
        setBanner('Some answers need a look before this can be sent.');
        bannerRef.current?.scrollIntoView({ block: 'center' });
        return;
      }
      setErrors({});
      setBanner(null);
      startTransition(async () => {
        const res = await bidAction(rfp.id, lane.proposal_id, draft);
        if (res.ok) {
          setSent(true);
          setBanner(null);
          bannerRef.current?.scrollIntoView({ block: 'center' });
        } else {
          setBanner(res.error);
          if (res.fieldErrors) setErrors(res.fieldErrors);
          bannerRef.current?.scrollIntoView({ block: 'center' });
        }
      });
    },
    [draft, pending, rfp.id, lane.proposal_id],
  );

  return (
    <div className="mkt">
      <header className="mkt-head">
        <button type="button" className="bid-back" onClick={() => router.push('/marketplace')}>
          ← Back to marketplace
        </button>
        <h1>{rfp.title}</h1>
        {rfp.scope_text ? <p className="mkt-sub">{rfp.scope_text}</p> : null}
        {rfp.specialties?.length ? (
          <div className="mkt-chips">
            {rfp.specialties.map((s) => (
              <span className="badge neutral" key={s}>{s}</span>
            ))}
          </div>
        ) : null}
        {rfp.submission_deadline ? (
          <p className="mkt-deadline">
            Proposals due by {formatDateOnly(rfp.submission_deadline.slice(0, 10))}.
          </p>
        ) : null}
      </header>

      <form className="bid-card" onSubmit={submit} noValidate>
        {sent ? (
          <p className="bid-sent" role="status" ref={bannerRef}>
            Your bid is in. The homeowner or contractor can see it now. You can
            update your figure below until the deadline.
          </p>
        ) : banner ? (
          <p className="bid-error" role="alert" ref={bannerRef}>{banner}</p>
        ) : null}

        <div className="bid-field">
          <label htmlFor="total">Your total ({BID_CURRENCY})</label>
          <div className="bid-money">
            <span aria-hidden="true">€</span>
            <input
              id="total" name="total" inputMode="decimal" value={draft.total}
              placeholder="250,000"
              aria-invalid={errors.total ? 'true' : undefined}
              aria-describedby={errors.total ? 'total-note' : undefined}
              onChange={(e) => set('total', e.target.value)}
            />
          </div>
          <FieldNote id="total-note" text={errors.total} />
        </div>

        <div className="bid-field">
          <label htmlFor="durationValue">Duration of the works</label>
          <div className="bid-duration">
            <input
              id="durationValue" name="durationValue" inputMode="numeric"
              value={draft.durationValue} placeholder="12"
              aria-invalid={errors.durationValue ? 'true' : undefined}
              aria-describedby={errors.durationValue ? 'durationValue-note' : undefined}
              onChange={(e) => set('durationValue', e.target.value)}
            />
            <select
              aria-label="Duration unit"
              value={draft.durationUnit}
              onChange={(e) => set('durationUnit', e.target.value as DurationUnit)}
            >
              <option value="weeks">weeks</option>
              <option value="wd">working days</option>
            </select>
          </div>
          <p className="bid-hint">A week counts as five working days.</p>
          <FieldNote id="durationValue-note" text={errors.durationValue} />
        </div>

        <div className="bid-field">
          <label htmlFor="validityUntil">Valid until (optional)</label>
          <input
            id="validityUntil" name="validityUntil" type="date"
            value={draft.validityUntil}
            aria-invalid={errors.validityUntil ? 'true' : undefined}
            aria-describedby={errors.validityUntil ? 'validityUntil-note' : undefined}
            onChange={(e) => set('validityUntil', e.target.value)}
          />
          <p className="bid-hint">How long the client has to accept this price.</p>
          <FieldNote id="validityUntil-note" text={errors.validityUntil} />
        </div>

        <div className="bid-field">
          <label htmlFor="conditions">Conditions or notes (optional)</label>
          <textarea
            id="conditions" name="conditions" rows={5} maxLength={4000}
            value={draft.conditions}
            placeholder="Anything the client should know, or anything this price assumes."
            aria-invalid={errors.conditions ? 'true' : undefined}
            aria-describedby={errors.conditions ? 'conditions-note' : undefined}
            onChange={(e) => set('conditions', e.target.value)}
          />
          <FieldNote id="conditions-note" text={errors.conditions} />
        </div>

        {sent && lane.summary ? (
          <p className="bid-current">
            On the record now: <strong>{formatEuro(lane.summary.total.amount_cents)}</strong>
            {lane.summary.duration_wd
              ? <> over {formatWorkingDays(lane.summary.duration_wd)}</>
              : null}.
          </p>
        ) : null}

        <div className="bid-submit">
          <span className="bid-submit-note">
            {sent ? 'You can revise this until the deadline.' : 'You can revise this after sending, until the deadline.'}
          </span>
          <button className="btn primary" type="submit" disabled={pending}>
            {pending ? 'Sending…' : sent ? 'Update bid' : 'Send bid'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A red note under a box. Renders nothing when there is nothing wrong. */
function FieldNote({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p className="bid-fieldnote" id={id}>
      {text}
    </p>
  );
}
