'use client';

// Approve / reject actions for a proposed change order. The acting party is
// derived server-side; the two-sided rule (proposer ≠ decider, FR4) is enforced
// by the API + a DB CHECK — this UI only offers the action and reports the
// result. Posts to POST /change-orders/:id/decision (§6).
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type State = 'idle' | 'sending' | 'demo' | string;

export function CoDecisionButtons({ id, canDecide }: { id: string; canDecide: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>('idle');

  if (!canDecide) {
    return (
      <p className="cap" style={{ marginTop: 4 }}>
        You proposed this change, so the other party decides it (FR4 — no self-approval).
      </p>
    );
  }

  async function decide(decision: 'approve' | 'reject') {
    setState('sending');
    try {
      const res = await fetch(`/api/v1/change-orders/${id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (res.status === 404 || res.status === 501) {
        setState('demo');
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setState(j?.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setState('demo');
    }
  }

  return (
    <div className="stack">
      <div className="btn-row">
        <button className="btn approve" disabled={state === 'sending'} onClick={() => decide('approve')}>
          ✓ Approve — move the budget
        </button>
        <button className="btn reject" disabled={state === 'sending'} onClick={() => decide('reject')}>
          Reject
        </button>
      </div>
      {state === 'demo' && (
        <div className="demo-banner" role="status">
          <strong>Demo mode.</strong> This would call <code>POST /api/v1/change-orders/{id}/decision</code>; on
          approve the Ledger &amp; Budget service moves the budget exactly once and appends the audit event. The
          Change-Order API (Slice 4) isn&apos;t wired to this deployment yet.
        </div>
      )}
      {state !== 'idle' && state !== 'sending' && state !== 'demo' && (
        <div className="integrity bad" role="alert">{state}</div>
      )}
    </div>
  );
}
