'use client';

// /rfp/[token] — the bid form, the one client island on an otherwise
// server-rendered page (LINA-360, S5). It holds the draft, gives instant field
// feedback with the SAME pure `validateBid` the server action re-runs as the
// authority, and submits through that action (actions.ts). It imports only the
// pure view module — never the server-only I/O — so nothing here drags
// `server-only` into the client bundle.
//
// ── THE BID IS A SINGLE TOTAL (Architect ruling, LINA-360) ────────────────────
// v1 collected a budget range, a company name, a website and portfolio images.
// The v2 proposal is a single summary total (EUR) + a working-day duration, with
// an optional conditions note and validity date; the bidder's identity comes from
// the recipient record, not typed here. Portfolio images await the token-scoped
// upload route (a follow-up), so there is no image tray yet.
import { useCallback, useRef, useState, useTransition } from 'react';

import {
  BID_CURRENCY,
  EMPTY_DRAFT,
  validateBid,
  type BidDraft,
  type BidErrors,
  type DurationUnit,
} from '@/lib/v2/rfp-link-view';

import { submitBidAction } from './actions';

export function ProposalForm({ token }: { token: string }) {
  const [draft, setDraft] = useState<BidDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<BidErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bannerRef = useRef<HTMLParagraphElement | null>(null);

  const set = useCallback(<K extends keyof BidDraft>(key: K, value: BidDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    // Clear the field's own error on edit, not on submit: a red note under a box
    // the person has just corrected reads as "still wrong".
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
        // On success the action redirects and this never resolves with a value;
        // a returned state is always a refusal to render in place.
        const res = await submitBidAction(token, draft);
        if (res?.error) {
          setBanner(res.error);
          if (res.fieldErrors) setErrors(res.fieldErrors);
          bannerRef.current?.scrollIntoView({ block: 'center' });
        }
      });
    },
    [draft, pending, token],
  );

  return (
    <form className="card" onSubmit={submit} noValidate>
      <div className="rfp-body">
        {banner ? (
          <p className="form-error" role="alert" ref={bannerRef}>{banner}</p>
        ) : null}

        <div className="field">
          <label htmlFor="total">Total ({BID_CURRENCY})</label>
          <div className="rfp-money">
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

        <div className="field">
          <label htmlFor="durationValue">Duration of the works</label>
          <div className="rfp-timeline">
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
          <p className="hint">A week counts as five working days.</p>
          <FieldNote id="durationValue-note" text={errors.durationValue} />
        </div>

        <div className="field">
          <label htmlFor="validityUntil">Valid until (optional)</label>
          <input
            id="validityUntil" name="validityUntil" type="date"
            value={draft.validityUntil}
            aria-invalid={errors.validityUntil ? 'true' : undefined}
            aria-describedby={errors.validityUntil ? 'validityUntil-note' : undefined}
            onChange={(e) => set('validityUntil', e.target.value)}
          />
          <p className="hint">How long the homeowner has to accept this price.</p>
          <FieldNote id="validityUntil-note" text={errors.validityUntil} />
        </div>

        <div className="field">
          <label htmlFor="conditions">Conditions or notes (optional)</label>
          <textarea
            id="conditions" name="conditions" rows={5} maxLength={4000}
            value={draft.conditions}
            placeholder="Anything the homeowner should know, or anything this price assumes."
            aria-invalid={errors.conditions ? 'true' : undefined}
            aria-describedby={errors.conditions ? 'conditions-note' : undefined}
            onChange={(e) => set('conditions', e.target.value)}
          />
          <FieldNote id="conditions-note" text={errors.conditions} />
        </div>
      </div>

      <div className="rfp-submit">
        <span className="rfp-submit-note">You can send one proposal for this request.</span>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send proposal'}
        </button>
      </div>
    </form>
  );
}

/** A red note under a box. Renders nothing when there is nothing wrong. */
function FieldNote({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p className="rfp-fieldnote" id={id}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.2v.6" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
