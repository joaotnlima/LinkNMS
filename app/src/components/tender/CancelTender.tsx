'use client';

// Cancel a tender with a one-line reason (PRD-02 T-19). Confirms in place; the
// reason is kept on the RFP and shown wherever the tender reads Cancelled.

import { useState } from 'react';

import { cancelRfpAction } from '../procurement-actions';
import type { V2Rfp } from '@/lib/v2/tendering-view';

export function CancelTender({ rfp, onCancelled }: { rfp: V2Rfp; onCancelled: (rfp: V2Rfp) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="tnd-link" onClick={() => setOpen(true)}>Cancel this tender…</button>
    );
  }
  const go = async () => {
    setBusy(true); setError(null);
    const res = await cancelRfpAction(rfp.id, reason);
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    onCancelled(res.data);
  };
  return (
    <div className="tnd-confirm" role="group" aria-label="Cancel the tender">
      <b>Cancel “{rfp.title}”?</b>
      <span>Bidders can no longer answer. Every proposal stays on the record, and the task&apos;s dates unlock.</span>
      <label className="tnd-field">
        <span className="tnd-label">Why (shown with the tender)</span>
        <input className="tnd-input" value={reason} maxLength={500}
          placeholder="e.g. The roof design changed — we will tender again"
          onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? <span className="tnd-err" role="alert">{error}</span> : null}
      <div className="tnd-row">
        <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(false)}>Keep it</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => void go()}>
          {busy ? 'Cancelling…' : 'Cancel tender'}
        </button>
      </div>
    </div>
  );
}
