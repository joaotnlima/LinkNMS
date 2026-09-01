'use client';

// Approve / reject actions for a proposed change order. The acting party is
// derived server-side; the two-sided rule (proposer ≠ decider, FR4) is enforced
// by the API + a DB CHECK — this UI only offers the action and reports the
// result. Posts to POST /change-orders/:id/decision (§6).
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type State = 'idle' | 'sending' | string;

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
      // Every non-2xx is a FAILURE, including 404 (LINA-57). This used to treat
      // 404/501/network as "demo mode" and reassure the user about what the
      // ledger *would* have done — so a decision that never persisted looked
      // like one that had. Approving a change order is the single most
      // consequential action in the product; it either moved the budget or it
      // did not, and the UI must not be the thing that blurs that.
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setState(j?.error?.message ?? `The decision was not recorded (${res.status}). Nothing has changed.`);
        return;
      }
      router.refresh();
    } catch {
      setState('The decision could not be sent, so nothing was recorded. Check your connection and try again.');
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
      {state !== 'idle' && state !== 'sending' && (
        <div className="integrity bad" role="alert">{state}</div>
      )}
    </div>
  );
}
