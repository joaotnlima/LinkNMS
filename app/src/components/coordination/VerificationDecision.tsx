'use client';

// Verifications waiting for my organisation (/me/verifications, PRD-12 N-3
// "surface them"): accept the work, or reject it with the reason measured
// against its acceptance criteria. Human-only on the server; never the
// organisation that reported it done.
import { useState } from 'react';

import { decideVerificationAction } from '@/lib/v2/quality-actions';

export function VerificationDecision({ projectId, verificationId }: { projectId: string; verificationId: string }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    if (!accept && !note.trim()) { setError('A rejection carries its reason.'); return; }
    setBusy(true); setError(null);
    const res = await decideVerificationAction(projectId, verificationId, accept, note);
    setBusy(false);
    if (!res.ok) setError(res.message);
  }

  return (
    <div className="crd-act">
      {rejecting ? (
        <>
          <textarea className="ste-field" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is not accepted (against the criteria)" />
          <button type="button" className="btn reject" disabled={busy} onClick={() => void decide(false)}>Reject</button>
          <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
        </>
      ) : (
        <>
          <button type="button" className="btn approve" disabled={busy} onClick={() => void decide(true)}>Accept</button>
          <button type="button" className="btn reject" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
        </>
      )}
      {error ? <p className="ste-error" role="alert">{error}</p> : null}
    </div>
  );
}
